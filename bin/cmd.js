#!/usr/bin/env node
var fs = require('fs')
var path = require('path')
var mkdirp = require('mkdirp')
var minimist = require('minimist')
var level = require('level')
var strftime = require('strftime')
var through = require('through')
var editor = require('editor')
var stringify = require('json-stable-stringify')
var parseTime = require('parse-messy-time')
var os = require('os')
var tmpdir = os.tmpdir()

var argv = minimist(process.argv.slice(2), {
  alias: { m: 'message', v: 'verbose', a: 'archive', t: 'type' },
  '--': true
})

var RESERVED_DATA_ENTRIES = [
  'start',
  'end',
  'type',
  'message'
]

var KEY_FORMAT = 'time!%F %T'

var HOME = process.env.HOME || process.env.USERPROFILE
var datadir = argv.d || path.join(HOME, '.clocker')
mkdirp.sync(datadir)

var db = level(path.join(datadir, 'db'), { valueEncoding: 'json' })

var d

(function () {
  var k, s, type, message, stamp, value, prop

  if (argv.h) usage(0)
  else if (argv._[0] === 'start') {
    d = argv.date ? new Date(argv.date) : new Date()
    message = argv.message
    type = argv.type
    if (typeof type === 'boolean') {
      error('Empty type specified')
    } else {
      start(d, message, type, error)
    }
  } else if (argv._[0] === 'stop') {
    d = argv.date ? new Date(argv.date) : new Date()
    k = argv.key || argv._[1]
    if (k) {
      var key = getKey(k)
      db.get(key, function (err, value) {
        if (err) error(err)
        else onrowstop({ key: key, value: value })
      })
    } else {
      db.createReadStream({
        gt: 'time!',
        lt: 'time!~',
        limit: 1,
        reverse: true
      }).once('data', onrowstop)
    }
  } else if (argv._[0] === 'restart') {
    k = argv.key || argv._[1]
    if (k) {
      db.get(getKey(k), function (err, value) {
        if (err) error(err)
        else onrowrestart({ value: value })
      })
    } else {
      getLastRow(onrowrestart)
    }
  } else if (argv._[0] === 'add' && argv._.length === 3) {
    var begin = strftime('%F %T', getDate(argv._[1]))
    var end = strftime('%F %T', getDate(argv._[2]))
    message = argv.message
    type = argv.type

    value = { type: type, message: message, end: end }
    var pkey = 'time!' + begin
    var tkey = 'time-type!' + type + '!' + begin

    db.batch([
      { type: 'put', key: pkey, value: value },
      { type: 'put', key: tkey, value: 0 }
    ], error)
  } else if (argv._[0] === 'status') {
    s = db.createReadStream({
      gt: 'time!',
      lt: 'time!~',
      limit: 1,
      reverse: true
    })
    var status = 'stopped'
    s.once('data', function (row) {
      var started = new Date(row.key.split('!')[1])
      if (!row.value.end) {
        var elapsed = (new Date()) - started
        status = 'elapsed time: ' + fmt(elapsed)
      }
    })
    s.once('end', function () {
      console.log(status)
    })
  } else if (argv._[0] === 'data') {
    type = argv.type || argv._[1]
    var typeIsRegExp = isRegExp(type)
    var rate = argv.rate || argv.r || argv._[2]
    var title = argv.title || 'consulting'

    s = db.createReadStream({
      gt: 'time!' + (argv.gt || ''),
      lt: 'time!' + (argv.lt || '~')
    })
    var rows = []
    var write = function (row) {
      if (row.value.archive && !argv.archive) return
      if (!type) return rows.push(row)
      if (row.value.type === type) return rows.push(row)
      if (typeIsRegExp && testRegExp(type, row.value.type)) return rows.push(row)
    }
    s.pipe(through(write, function () {
      var hours = rows.reduce(function reducer (acc, row) {
        var begin = new Date(row.key.split('!')[1])
        var end = row.value.end ? new Date(row.value.end) : new Date()
        key = strftime('%F', begin)
        if (key !== strftime('%F', end)) {
          var nextDay = new Date(begin)
          nextDay.setDate(begin.getDate() + 1)
          nextDay.setHours(0)
          nextDay.setMinutes(0)
          nextDay.setSeconds(0)
          nextDay.setMilliseconds(0)

          acc = reducer(acc, {
            key: 'time!' + strftime('%F %T', nextDay),
            value: row.value
          })
          end = nextDay
        }
        var hours = (end - begin) / 1000 / 60 / 60
        if (!acc[key]) {
          acc[key] = {
            date: strftime('%F', begin),
            hours: 0
          }
        }
        acc[key].hours += hours
        return acc
      }, {})

      console.log(stringify([ {
        title: title,
        rate: rate,
        hours: Object.keys(hours).map(function (key) {
          var h = hours[key]
          return {
            date: h.date,
            hours: Number(h.hours.toFixed(2))
          }
        })
      } ], { space: 2 }))
    }))
  } else if (argv._[0] === 'csv') {
    var additionalFields = []
    if (argv.props) {
      additionalFields = argv.props.split(',')
    }

    // print header
    var header = 'Key,Date,Start,End,Duration,Archived,Type,Message'
    if (additionalFields.length) {
      header += ','
      header += additionalFields.join(',')
    }
    console.log(header)

    s = db.createReadStream({
      gt: 'time!' + (argv.gt || ''),
      lt: 'time!' + (argv.lt || '~')
    })
    s.on('error', error)
    s.pipe(through(function (row) {
      if (row.value.archive && !argv.archive) return
      if (argv.type && !isRegExp(argv.type) && row.value.type !== argv.type) return
      if (argv.type && isRegExp(argv.type) && !testRegExp(argv.type, row.value.type)) return

      var begin = new Date(row.key.split('!')[1])
      var end = row.value.end && new Date(row.value.end)
      var elapsed = (end || new Date()) - begin

      var output = '%s,%s,%s,%s,%s,%s,"%s","%s"'
      var fields = [
        toStamp(row.key),
        strftime('%F', begin),
        strftime('%T', begin),
        end ? strftime('%T', end) : 'NOW',
        fmt(elapsed),
        (row.value.archive ? 'A' : ''),
        (row.value.type || '').replace(/"/g, '""'),
        (row.value.message || '').replace(/"/g, '""')
      ]
      if (additionalFields.length) {
        output += ','
        output += additionalFields.map(function () { return '"%s"' }).join(',')

        fields = fields.concat(additionalFields.map(function (prop) {
          return (row.value[prop] || '').toString().replace(/"/g, '""')
        }))
      }

      console.log.apply(null, [output].concat(fields))
    }))
  } else if (argv._[0] === 'list' || argv._[0] === 'ls') {
    s = db.createReadStream({
      gt: 'time!' + (argv.gt || ''),
      lt: 'time!' + (argv.lt || '~')
    })
    s.on('error', error)
    s.pipe(through(function (row) {
      if (argv.raw) return console.log(stringify(row))
      if (row.value.archive && !argv.archive) return
      if (argv.type && !isRegExp(argv.type) && row.value.type !== argv.type) return
      if (argv.type && isRegExp(argv.type) && !testRegExp(argv.type, row.value.type)) return

      var begin = new Date(row.key.split('!')[1])
      var end = row.value.end && new Date(row.value.end)
      var elapsed = (end || new Date()) - begin

      printEntry(row.key, begin, end, elapsed, row.value.type, row.value.archive)

      if (argv.verbose) {
        printMessage(row.value.message)
      }
    }))
  } else if (argv._[0] === 'get') {
    key = getKey(argv._[1])
    db.get(key, function (err, row) {
      if (err) return error(err)
      console.log(row)
    })
  } else if (argv._[0] === 'rm') {
    argv._.slice(1).forEach(function (k) {
      key = getKey(k)
      db.del(key, error)
    })
  } else if (argv._[0] === 'set') {
    if (argv._.length < 3) {
      error('clocker set [STAMP] KEY VALUE')
    } else if (argv._.length === 3) {
      getLastRow(function (row) {
        stamp = row.key.split('!')[1]
        prop = argv._[1]
        value = argv._.slice(2).join(' ')
        set(stamp, prop, value)
      })
    } else {
      stamp = argv._[1]
      prop = argv._[2]
      value = argv._.slice(3).join(' ')
      set(stamp, prop, value)
    }
  } else if (argv._[0] === 'edit') {
    stamp = argv._[1]
    key = getKey(stamp)
    prop = argv._[2]

    db.get(key, function (err, row) {
      if (err) return error(err)
      var src = stringify(prop ? row[prop] : row, { space: 2 })
      edit(src, function (err, src_) {
        if (err) return error(err)
        if (prop) {
          row[prop] = src_
          return set(stamp, prop, row)
        }
        row = JSON.parse(src_)
        try { var x = JSON.parse(src_) } catch (err) {
          return error('error parsing json')
        }
        db.put(key, x, function (err) {
          if (err) return error(err)
          if (!x || typeof x !== 'object') {
            return error('not an object: ' + x)
          }
          if (x.type !== row.type) {
            set(stamp, 'type', x.type, row.type)
          }
        })
      })
    })
  } else if (argv._[0] === 'insert') {
    key = getKey(argv._[1])
    db.put(key, {}, function (err) {
      if (err) return error(err)
    })
  } else if (argv._[0] === 'archive' || argv._[0] === 'unarchive') {
    value = argv._[0] === 'archive'
    if (argv._.length > 1) {
      return argv._.slice(1).forEach(function (stamp) {
        set(stamp, 'archive', value)
      })
    }
    s = db.createReadStream({
      gt: 'time!' + (argv.gt || ''),
      lt: 'time!' + (argv.lt || '~')
    })
    s.on('error', error)
    s.pipe(through(function (row) {
      if (row.value.archive) return
      if (argv.type && row.value.type !== argv.type) return

      row.value.archive = value
      db.put(row.key, row.value, error)
    }))
  } else if (argv._[0] === 'report') {
    // options and arguments
    var day = argv.reportDay

    // get report data
    var reportDay = (day && typeof day === 'string') ? getDate(day) : new Date()
    var reportDayTomorrow = new Date(reportDay)
    reportDayTomorrow.setDate(reportDayTomorrow.getDate() + 1)

    console.log('Report for %s:', printDate(reportDay))

    s = db.createReadStream({
      gt: 'time!' + (strftime('%F', reportDay) || ''),
      lt: 'time!' + (strftime('%F', reportDayTomorrow) || '~')
    })
    s.on('error', error)

    var sumsByType = {}
    var totalSum = 0

    s.pipe(through(function (row) {
      var begin = new Date(row.key.split('!')[1])
      var end = row.value.end && new Date(row.value.end)
      var elapsed = (end || new Date()) - begin

      printEntry(row.key, begin, end, elapsed, row.value.type, row.value.archive)
      if (argv.verbose) {
        printMessage(row.value.message)
      }

      sumsByType[row.value.type] ? sumsByType[row.value.type] += elapsed : sumsByType[row.value.type] = elapsed
    }, function end () {
      console.log('')
      for (var stype in sumsByType) {
        console.log('%s: %s', stype, fmt(sumsByType[stype]))
        totalSum += sumsByType[stype]
      }
      console.log('\ntotal: %s', fmt(totalSum))
    }))
  } else usage(1)
})()

function start (date, message, type, data, cb) {
  var pkey = strftime(KEY_FORMAT, d)
  var tkey = 'time-type!' + type + '!' + strftime('%F %T', d)
  var value = addData({ type: type, message: message })
  db.batch([
    { type: 'put', key: pkey, value: value },
    { type: 'put', key: tkey, value: 0 }
  ], cb)
}

function edit (src, cb) {
  var file = path.join(tmpdir, 'clocker-' + Math.random())
  fs.writeFile(file, src || '', function (err) {
    if (err) error(err)
    else {
      editor(file, function (code, sig) {
        if (code !== 0) {
          return error('non-zero exit code from $EDITOR')
        }
        fs.readFile(file, function (err, src) {
          if (err) error(err)
          else cb(null, src)
        })
      })
    }
  })
}

function usage (code) {
  var rs = fs.createReadStream(path.join(__dirname, 'usage.txt'))
  rs.pipe(process.stdout)
  rs.on('close', function () {
    if (code) process.exit(code)
  })
}

function onrowstop (row) {
  var m = argv.message
  if (m) {
    if (row.value.message) m = row.value.message + '\n' + m
    row.value.message = m
  }
  row.value.end = strftime('%F %T', d)
  db.put(row.key, row.value, error)
}

function onrowrestart (row) {
  start(new Date(), row.value.message, row.value.type, error)
}

function pad (s, len) {
  return Array(Math.max(0, len - String(s).length + 1)).join('0') + s
}

function fmt (elapsed) {
  var n = elapsed / 1000
  var hh = pad(Math.floor(n / 60 / 60), 2)
  var mm = pad(Math.floor(n / 60 % 60), 2)
  var ss = pad(Math.floor(n % 60), 2)
  return [ hh, mm, ss ].join(':')
}

function set (stamp, prop, value, originalValue) {
  var key = getKey(stamp)

  if (prop === 'stop') {
    // Use 'stop' as synonym for 'end'
    prop = 'end'
  }

  if (prop === 'end') {
    db.get(key, function (err, row) {
      if (err) return error(err)
      row[prop] = updateDate(key, value, originalValue || row[prop])
      db.put(key, row, error)
    })
  } else if (prop === 'start') {
    db.get(key, function (err, row) {
      if (err) return error(err)
      var newKey = 'time!' + updateDate(key, value, key.split('!')[1])

      if (newKey !== key) {
        db.batch([
          { type: 'put', key: newKey, value: row },
          { type: 'del', key: key }
        ], error)
      }
    })
  } else if (prop === 'type') {
    db.get(key, function (err, row) {
      if (err) return error(err)
      var prevType = originalValue || row.type
      row.type = value
      db.batch([
        prevType && { type: 'del', key: prevType },
        { type: 'put', key: key, value: row }
      ].filter(Boolean), error)
    })
  } else {
    db.get(key, function (err, row) {
      if (err) return error(err)
      if (value === '') delete row[prop]
      else row[prop] = value
      db.put(key, row, error)
    })
  }
}

function error (err) {
  if (!err) return
  console.error(String(err))
  process.exit(1)
}

function toStamp (s) {
  return Math.floor(new Date(s.split('!')[1]).valueOf() / 1000)
}

function getKey (x) {
  if (x === 'NaN') return strftime(KEY_FORMAT, new Date(NaN))

  if (!/^\d+$/.test(x)) return 'time!' + x
  return strftime(KEY_FORMAT, new Date(x * 1000))
}

function getLastRow (callback) {
  db.createReadStream({
    gt: 'time!',
    lt: 'time!~',
    limit: 1,
    reverse: true
  }).once('data', callback)
}

function isUnixTimestamp (expr) {
  return /^1[0-9]{9}$/.test(expr)
}

function getDate (expr) {
  var d
  var timestamp = Date.parse(expr)

  if (isUnixTimestamp(expr)) {
    d = new Date(expr * 1000)
  } else if (isNaN(timestamp)) {
    d = parseTime(expr)
  } else {
    d = new Date(timestamp)
  }

  return d
}

function updateDate (key, value, old) {
  var d = getDate(value)

  if (isNaN(d.valueOf())) {
    if (!old || isNaN(old)) {
      old = key.split('!')[1]
    }
    d = new Date(old.split(' ')[0] + ' ' + value)
  }
  return strftime('%F %T', d)
}

function isRegExp (str) {
  return /^\/.*\/$/.test(str)
}

function testRegExp (re, str) {
  return RegExp(re.slice(1, -1)).test(str)
}

function printEntry (key, start, end, elapsed, type, archive) {
  console.log(
    '%s  %s  [ %s - %s ]  (%s)%s%s',
    toStamp(key),
    strftime('%F', start),
    strftime('%T', start),
    end ? strftime('%T', end) : 'NOW',
    fmt(elapsed),
    (type ? '  [' + type + ']' : ''),
    (archive ? ' A' : '')
  )
}

function printDate (date) {
  var monthNames = [
    'January', 'February', 'March',
    'April', 'May', 'June', 'July',
    'August', 'September', 'October',
    'November', 'December'
  ]

  return date.getDate() + ' ' + monthNames[date.getMonth()] + ' ' + date.getFullYear()
}

function printMessage (message) {
  if (message) {
    var lines = message.split('\n')
    console.log()
    lines.forEach(function (line) {
      console.log('    ' + line)
    })
    console.log()
  }
}

function addData (obj) {
  var data = minimist(argv['--'])
  for (var key in data) {
    if (RESERVED_DATA_ENTRIES.indexOf(key) >= 0) {
      return error('Reserved data key specified: ' + key)
    }
    if (key === '_' || key === '--') {
      continue
    }
    obj[key] = data[key]
  }
  return obj
}
