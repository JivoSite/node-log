const app     = process;
const Timer   = app.binding('timer_wrap').Timer;
const fs      = app.binding('fs');
const FSReq   = fs.FSReqWrap;
const CONST   = app.binding('constants').fs;
const cares   = app.binding('cares_wrap');
const udp     = app.binding('udp_wrap');
const UDP     = udp.UDP;
const UDPSend = udp.SendWrap;

const FOF_LOG = CONST.O_APPEND | CONST.O_CREAT | CONST.O_WRONLY;
const FOM_LOG = 0o640;
const REOPEN  = 60000;

const loggers = {};
const streams = {};
const formats = {};
const means   = {};

let MASK = null;
let VERB = false;
let BINF = 16;

const ascii = function (str)
{
   return String(str).replace(/[^\x20-\x7F]/g, '_');
};

const line = function (str)
{
   return String(str).replace(/[\x00-\x19]/g, ' ');
};

const escape = function (str)
{
   return JSON.stringify(String(str)).slice(1, -1);
};

const error2line = function (err)
{
   if (!err) return 'Error: ';
   if (VERB && err.stack) return line(err.stack);
   else return line(err.name + ': ' + err.message);
};

const npath = function (path)
{
   if (void 0 === path) return path;
   if ('string' !== typeof path)
   {
      throw new TypeError('path must be string');
   }
   if (-1 !== path.indexOf('\0'))
   {
      throw new RangeError('null byte in path');
   }
   if ('~' === path[0])
   {
      switch (path[1])
      {
         case (void 0) : return app.env.HOME;
         case '/' : return app.env.HOME + path.substring(1);
         case '+' : return app.env.PWD + '/' + path.substring(2);
         case '-' : return app.env.OLDPWD + '/' + path.substring(2);
         default : return '/home/' + path.substring(1);
      }
   }

   return path;
};

formats.tab = function (opt)
{
   let prefix = 'time\t[name]\t{id}';

   if (void 0 !== opt.query)
   {
      prefix = line(opt.query).replace(/&/g, '\t');
   }

   return function (id, level, args)
   {
      let msg = prefix;

      msg = msg.replace(/\btime\b/, now());
      msg = msg.replace(/\bname\b/, name[level]);
      msg = msg.replace(/\bid\b/,   id);
      for (let i = 0; i < args.length; ++i)
      {
         if (0 !== args.length || 0 !== msg.length)
         {
            msg += '\t';
         }
         if ('string' === typeof args[i])
         {
            msg += line(args[i]);
         }
         else if (args[i] instanceof Error)
         {
            msg += error2line(args[i]);
         }
         else
         {
            try { msg += JSON.stringify(args[i]); }
            catch (ex) { msg += '[Circular]'; }
         }
      }

      return msg;
   };
};

formats.tty = function (opt)
{
   let prefix = 'time\tname\tid';

   if (void 0 !== opt.query)
   {
      prefix = line(opt.query).replace(/&/g, '\t');
   }

   return function (id, level, args)
   {
      let msg = prefix;

      msg = msg.replace(/\btime\b/, now(false, true));
      msg = msg.replace(/\bname\b/
         , color[level] + name[level] + color.default);
      msg = msg.replace(/\bid\b/,   color.id + id + color.default);
      for (let i = 0; i < args.length; ++i)
      {
         if (0 !== args.length && 0 !== msg.length)
         {
            msg += '\t';
         }
         msg += colorize(args[i]);
      }

      return msg;
   };
};

formats.io = function (opt)
{
   let prefix = 'time\tname\tid';

   if (void 0 !== opt.query)
   {
      prefix = line(opt.query).replace(/&/g, '\t');
   }

   return function (id, level, args)
   {
      let msg = prefix;

      msg = msg.replace(/\btime\b/, now(false, true));
      msg = msg.replace(/\bname\b/
         , color[level] + name[level] + color.default);
      msg = msg.replace(/\bid\b/,   color.id + id + color.default);
      if (void 0 !== args[2]) msg += '\t' + colorize(args[2]);
      let type = 'none', value;
      if ('string' === typeof args[1])
      {
         type = 'string';
         value = args[1];
      }
      else if (args[1] instanceof Error)
      {
         type = 'error';
         value = args[1].stack;
      }
      else if (args[1] instanceof Buffer)
      {
         type = 'buffer';
         value = bin(args[1], BINF, 0, '');
      }
      else
      {
         type = typeof args[1];
         try { value = JSON.stringify(args[1], null, '   '); }
         catch (ex) { value = '[Circular]'; }
      }

      return msg + '\t' + type + '\n'
         + (args[0] ? color.in : color.out) + value + color.default;
   };
};

formats.gelf = function (opt)
{
   let host = line(opt.userinfo);

   return function (id, level, args)
   {
      let full = '';

      for (let i = 0; i < args.length; ++i)
      {
         if (args[i] instanceof Error)
         {
            full += '[' + error2line(args[i]) + ']';
         }
         else
         {
            try { full += JSON.stringify(args[i]); }
            catch (ex) { full += '[Circular]'; }
         }
         if (i < args.length - 1) full += '\t';
      }

      return JSON.stringify({
         version       : '1.1',
         host          : host,
         short_message : id,
         full_message  : full,
         timestamp     : now(true),
         level         : level
      });
   };
};

const BOM = Buffer.from([0xEF, 0xBB, 0xBF]).toString();
const NIL = '-';
formats.syslog = function (opt)
{
   let hostname = NIL;
   let appname  = NIL;
   let facility = 1;
   let query = String(opt.query).split(/&/g);
   for (let i = 0; i < query.length; ++i)
   {
      let pair = query[i].split('=');
      if (2 !== pair.length) continue;
      switch (pair[0].toLowerCase())
      {
         case 'hostname' : hostname = ascii(pair[1]); break;
         case 'appname'  : appname  = ascii(pair[1]); break;
         case 'facility' : facility = pair[1];       break;
         default : throw new Error('log: invalid syslog field `'
            + pair[0] + '`, valid: hostname, appname, facility');
      }
   }
   facility = +facility;
   if (isNaN(facility) || 0 > facility || 23 < facility || facility % 1)
   {
      throw new Error('log: invalid facility');
   }
   let head = ' ' + hostname + ' ' + appname + ' ' + app.pid + ' ';

   return function (id, level, args)
   {
      let msg = '<' + ((facility * 8) + level) + '>1 '
         + (new Date).toISOString() + head + ascii(id || NIL)
         + ' - ' + BOM;

      for (let i = 0; i < args.length; ++i)
      {
         if (args[i] instanceof Error)
         {
            msg += '[' + error2line(args[i]) + ']';
         }
         else
         {
            try { msg += JSON.stringify(args[i]); }
            catch (ex) { msg += '[Circular]'; }
         }
         if (i < args.length - 1) msg += '\t';
      }

      return msg;
   };
};

Object.freeze(formats);

const main = (app.stderr && app.stderr.isTTY
   ? formats.tty({})
   : formats.tab({}));
const log = function ()
{
   app.stderr.write(main('main', 8, arguments) + '\n');
};

module.exports = log;

log.emerg = function ()
{
   app.stdout.write(main('main', 0, arguments) + '\n');
   app.exit(1);
};

log.NONE    = (0)          // off log
log.EMERG   = (0)          // system is unusable
log.ALERT   = (1 << 0)     // action must be taken immediately
log.CRIT    = (1 << 1)     // critical conditions
log.ERR     = (1 << 2)     // error conditions
log.WARNING = (1 << 3)     // warning conditions
log.NOTICE  = (1 << 4)     // normal but significant condition
log.INFO    = (1 << 5)     // informational
log.DEBUG   = (1 << 6)     // debug-level messages
log.ALL     = (1 << 7) - 1 // all messages

const name = [
   'emerg',
   'alert',
   'crit',
   'err',
   'warning',
   'notice',
   'info',
   'debug',
   'tip'
];
Object.freeze(name);

const color = [
   '\x1B[1;97;40m', // emerg
   '\x1B[1;97;48;5;196m', // alert
   '\x1B[1;97;48;5;202m', // crit
   '\x1B[1;91;48;5;220m', // err
   '\x1B[97;48;5;34m', // warning
   '\x1B[97;48;5;27m', // notice
   '\x1B[97;48;5;20m', // info
   '\x1B[97;48;5;90m', // debug
   '\x1B[30;107m' // tip
];
color.default   = '\x1B[0m';
color.in        = '\x1B[94m'; // Light blue
color.out       = '\x1B[35m'; // Light red
color.time      = '\x1B[2m'; // Dim
color.date      = '\x1B[94m'; // Light blue
color.id        = '\x1B[4m'; // Underlined
color.undefined = '\x1B[90m'; // Dark gray
color.null      = '\x1B[1m'; // Bold
color.true      = '\x1B[1;34m'; // Blue
color.false     = '\x1B[1;31m'; // Red
color.number    = '\x1B[92m'; // Light green
color.string    = '\x1B[32m'; // Green
color.circular  = '\x1B[96m'; // Light cyan
color.buffer    = '\x1B[95m'; // Light magenta
color.error     = '\x1B[93m'; // Light yellow
color.function  = '\x1B[36m'; // Cyan
color.regexp    = '\x1B[33m'; // Yellow
Object.freeze(color);

const colorize = log.colorize = function (obj, link)
{
   let str;
   if ('object' === typeof obj)
   {
      if (null === obj)
      {
         str = color.null + 'null';
      }
      else if (obj instanceof Error)
      {
         str = color.error + '[' + error2line(obj) + ']';
      }
      else if (obj.constructor === Buffer)
      {
         const M = 8;
         str = color.buffer + '<Buffer ' + obj.toString('hex', 0, M)
            .replace(/(..)/g, '$1 ')
            .replace(/ $/, (M < obj.length
               ? ' … ' + (obj.length - M)
               : ''))
            + '>';
      }
      else if (obj.constructor === RegExp)
      {
         str = color.regexp
            + JSON.stringify(obj.toString()).slice(1, -1);
      }
      else if (obj.constructor === Date)
      {
         str = color.date + obj.toString();
      }
      else
      {
         if ('function' === typeof obj.toJSON)
         {
            try { str = obj.toJSON(); }
            catch (ex) { }
            if ('string' === typeof str)
            {
               return color.string + '"' + str + '"' + color.default;
            }
         }
         if (link instanceof Array)
         {
            for (let i = 0; i < link.length; ++i)
            {
               if (obj === link[i])
               {
                  return color.circular + '[Circular]' + color.default;
               }
            }
            link.push(obj);
         }
         else link = [obj];
         let l = link.length - 1;
         if (obj instanceof Array)
         {
            str = '[ ';
            for (let i = 0; i < obj.length; ++i)
            {
               if (0 !== i) str += ', ';
               str += colorize(obj[i], link);
            }
            str += ' ]';
         }
         else
         {
            str = '{ ';
            let sep = '';
            for (let i in obj)
            {
               str += sep;
               str += i + ': ';
               str += colorize(obj[i], link);
               sep = ', ';
            }
            str += ' }';
         }
         link.splice(l);
      }
   }
   else if (true === obj)
   {
      str = color.true + String(obj);
   }
   else if (false === obj)
   {
      str = color.false + String(obj);
   }
   else if ('function' === typeof obj)
   {
      str = color.function + '[Function'
         + line(obj.name ? ': ' + obj.name : '')
         + ']';
   }
   else if ('string' === typeof obj)
   {
      str = JSON.stringify(obj).slice(1, -1);
      if (void 0 !== link) str = '\'' + str + '\'';
      str = color.string + str;
   }
   else
   {
      str = color[typeof obj] + String(obj);
   }

   return str + color.default;
};

log.add = function (opts)
{
   if (void 0 === opts || null === opts)
   {
      return log;
   }
   if ('object' !== typeof opts)
   {
      throw new TypeError('log: invalid options');
   }
   for (let i in opts)
   {
      if (i in loggers) continue;
      loggers[i] = newLogger(i, opts[i]);
   }

   return log;
};

log.get = function (id)
{
   return loggers[id] || dummy;
};

Object.defineProperty(log, 'level',
{
   get : function () { return MASK; },
   set : function (value)
   {
      if (null === value) MASK = null;
      else MASK = parseLevel(value);
   },
   enumerable   : true,
   configurable : false
});

Object.defineProperty(log, 'verbose',
{
   get : function () { return VERB; },
   set : function (value) { VERB = !!value; },
   enumerable   : true,
   configurable : false
});

Object.defineProperty(log, 'chunked',
{
   get : function () { return (1 < UDPCNT ? UDPCNT : 0); },
   set : function (value)
   { let val = Math.ceil(value); VERB = (1 < val ? val : 1); },
   enumerable   : true,
   configurable : false
});

Object.defineProperty(log, 'binary',
{
   get : function () { return BINF; },
   set : function (value) { let val = value << 0;
      if (2 === val || 8 === val || 10 === val || 16 === val)
         BINF = val;
   },
   enumerable   : true,
   configurable : false
});

Object.freeze(log);

const noop = function () { };

const dummy   = function () { };
dummy.emerg   = function () { };
dummy.alert   = function () { };
dummy.crit    = function () { };
dummy.err     = function () { };
dummy.warning = function () { };
dummy.notice  = function () { };
dummy.info    = function () { };
dummy.debug   = function () { };
Object.freeze(dummy);
Object.freeze(dummy.emerg);
Object.freeze(dummy.alert);
Object.freeze(dummy.crit);
Object.freeze(dummy.err);
Object.freeze(dummy.warning);
Object.freeze(dummy.notice);
Object.freeze(dummy.info);
Object.freeze(dummy.debug);

const zeroPad = function (num, len)
{
   num = String(num);
   while (num.length < len) num = '0' + num;
   return num;
};

const now = function (unix, clr)
{
   if (true === unix) return Date.now() / 1000;
   let d = new Date();
   if (true !== clr)
   {
      return d.getFullYear()
         + '-' + zeroPad(d.getMonth() + 1, 2)
         + '-' + zeroPad(d.getDate(), 2)
         + ' ' + zeroPad(d.getHours(), 2)
         + ':' + zeroPad(d.getMinutes(), 2)
         + ':' + zeroPad(d.getSeconds(), 2)
         + '.' + zeroPad(d.getMilliseconds(), 3);
   }

   return color.time
      + d.getFullYear()
      + '-' + zeroPad(d.getMonth() + 1, 2)
      + '-' + zeroPad(d.getDate(), 2)
      + color.default
      + ' ' + zeroPad(d.getHours(), 2)
      + ':' + zeroPad(d.getMinutes(), 2)
      + ':' + zeroPad(d.getSeconds(), 2)
      + color.time
      + '.' + zeroPad(d.getMilliseconds(), 3)
      + color.default;
};

const bin = function (buf, base, cols, indent)
{
   if (!(buf instanceof Buffer))
   {
      if ('string' === typeof buf)
      {
         if ('' === buf) return buf;
         buf = new Buffer(buf);
      }
      else
      {
         throw new TypeError(
            'log.bin: first argument must be buffer or string');
      }
   }
   let s, w, b;
   switch (base)
   {
      case 'hex' :
      case '16' :
      case 16 :
      case void 0 :
         if (!cols) cols = 65;
         s = '   '; //3
         w = 2;
         b = 16;
         break;
      case 'bin' :
      case '2' :
      case 2 :
         if (!cols) cols = 41;
         s = '         '; //9
         w = 8;
         b = 2;
         break;
      case 'dec' :
      case '10' :
      case 10 :
         if (!cols) cols = 41;
         s = '    '; //4
         w = 3;
         b = 10;
         break;
      case 'oct' :
      case '8' :
      case 8 :
         if (!cols) cols = 41;
         s = '    '; //4
         w = 3;
         b = 8;
         break;
      default : throw new Error('bin: invalid base');
   }

   const d = (/^ +$/.test(indent) ? indent : '');
   if (d.length) cols -= d.length;
   const z = '·', p = ' '
      , a = /[\x00-\x1F\x7F]/g
      , c = ((cols - 1) / (w + 2)) << 0;
   let str = '', i = 0, h = '', t;

   while (i < buf.length)
   {
      if (i && !(i % c))
      {
         if (str.length) str += '\n';
         str += d;
         while (h.length < c * (w + 1)) h += s;
         str += h;
         str += p;
         str += buf.toString('ascii', i - c, i).replace(a, z);
         h = '';
      }
      t = buf[i].toString(b);
      while (t.length < w) { t = '0' + t; }
      h += t + p;
      ++i;
   }
   if (str.length) str += '\n';
   str += d;
   t = c;
   while (h.length < c * (w + 1)) { h += s; --t; }
   str += h;
   str += p;
   str += buf.toString('ascii', i - t).replace(a, z);

   return str;
};

means.file = function (id, mask, opt, format)
{
   if ('function' !== typeof format)
   {
      format = formats.tab(opt);
   }

   let fd = -1;
   fd = fs.open(opt.path, FOF_LOG, FOM_LOG);

   return Object.freeze({
      open : function (close)
      {
         if (close)
         {
            if (-1 !== fd) fs.close(fd);
            fd = -1;
         }
         if (-1 === fd) fd = fs.open(opt.path, FOF_LOG, FOM_LOG);
      },
      write : function (level, bit, args)
      {
         if (-1 === fd || (0 !== bit && 0 === (mask & bit))) return;
         let str = format(id, level, args) + '\n';
         let req = new FSReq();
         req.oncomplete = noop;
         fs.writeString(fd, str, null, 'utf8', req);
      }
   });
};

const UDPLEN = 0x2000;
const UDPHDR = Buffer.from([0x1E, 0x0F, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const UDPCHK = UDPLEN - UDPHDR.length;
let   UDPCNT = 0x01; // XXX greylog supported 0x80
const udpChunks = function (str)
{
   let buf = Buffer.from(str);
   if (UDPLEN >= buf.length) return [buf];
   let cnt = Math.ceil(buf.length / UDPCHK);
   if (UDPCNT < cnt)
   {
      log(new RangeError('udp skip big message ' + buf.length));
      return [];
   }
   UDPHDR.writeUInt32BE((Date.now() / 1000) << 0, 2);
   UDPHDR.writeUInt32BE((Math.random() * 0xFFFFFF) << 0, 6);
   UDPHDR[11] = cnt;
   let chunks = [], num = 0, off;
   while (num < cnt)
   {
      off = num * UDPCHK;
      UDPHDR[10] = num;
      chunks.push(Buffer.concat(
         [UDPHDR, buf.slice(off, off + UDPCHK)]));
      ++num;
   }

   return chunks;
};

means.udp = function (id, mask, opt, format)
{
   if (!opt.port) throw new Error('upd port required');
   let _ip = opt.host;
   let _port = opt.port;
   let _send = noop;
   switch (cares.isIP(_ip))
   {
      case 4 :
         _send = function (chunks)
         {
            return _udp.send(new UDPSend(), chunks, chunks.length
               , _port, _ip, false);
         };
         break;
      case 6 :
         _send = function (chunks)
         {
            return _udp.send6(new UDPSend(), chunks, chunks.length
               , _port, _ip, false);
         };
         break;
      default : throw new Error('udp host must be ip4 or ip6');
   }
   let _udp = new UDP();
   if ('function' !== typeof format)
   {
      format = formats.syslog(opt);
   }

   return Object.freeze({
      open  : noop,
      write : function (level, bit, args)
      {
         if (0 !== bit && 0 === (mask & bit)) return;
         let chunks = udpChunks(format(id, level, args));
         if (0 === chunks.length) return;
         let err =_send(chunks);
      }
   });
};

means.tty = function (id, mask, opt, format)
{
   if ('function' !== typeof format)
   {
      format = formats.tty(opt);
   }

   return Object.freeze({
      open  : noop,
      write : function (level, bit, args)
      {
         if (0 !== bit && 0 === (mask & bit)) return;
         let str = format(id, level, args) + '\n';
         app.stdout.write(str);
      }
   });
};

Object.freeze(means);

const parseLevel = function (val)
{
   if ('-' === val)
   {
      return log.NONE;
   }
   if ('' === val || '+' === val || true === val)
   {
      return log.ALL;
   }
   if (isFinite(+val) || false === val)
   {
      return log.ALL & val;
   }
   if ('string' === typeof val)
   {
      val = val.split('+');
      let res = 0;
      for (let i = 0; i < val.length; ++i)
      {
         let l = val[i].toLowerCase();
         if ('' === l) continue;
         if ('all' === l) return log.ALL;
         let j = name.length;
         while (0 <= --j)
         {
            if (0 === name[j].indexOf(l))
            {
               if (0 === j) break;
               res |= 1 << (j - 1);
               if ('' === val[i + 1])
               {
                  while (0 < --j)
                  {
                     res |= 1 << (j - 1);
                  }
                  ++i;
               }
               break;
            }
         }
         if (0 > j)
         {
            throw new Error('invalid level');
         }
      }
      return res;
   }
   throw new TypeError('invalid level type');
};

const PURI =
/^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/;
//   { scheme }          {authori}ty{ path }     {query}      {fr}agment

const PAUTH =
/^(?:([^@]*)@)?(?:([^\:]*)|(?:\[([^\[\]]*)\]))(?::([0-9]*))?$/;
//   {useri}nfo   { host }      {  ipv6  }        { port }

const PEXT =
/^(.*)(?:\.([^\/\.]+))$/;

const getStream = function (id, uri)
{
   uri = decodeURI(uri);
   if (uri in streams)
   {
      return streams[uri];
   }
   let r;
   if (null === (r = PURI.exec(uri)))
   {
      throw new Error('invalid uri');
   }
   let fragment  = decodeURIComponent(r[5] || '');
   let authority = r[2];
   let extention;
   let pathname;
   let opt =
   {
      scheme   : r[1],
      path     : r[3],
      query    : r[4]
   }
   if (opt.scheme) opt.scheme = decodeURIComponent(opt.scheme);
   if (opt.path)   opt.path = npath(decodeURIComponent(opt.path));
   if (opt.query)  opt.query = decodeURIComponent(opt.query);
   if (void 0 !== authority)
   {
      if (null === (r = PAUTH.exec(authority)))
      {
         throw new Error('invalid uri');
      }
      opt.userinfo = r[1];
      opt.host = (void 0 !== r[2] ? r[2] : r[3]);
      if (opt.userinfo) opt.userinfo = decodeURIComponent(opt.userinfo);
      if (opt.host) opt.host = decodeURIComponent(opt.host);
      opt.port = r[4];
      if (void 0 !== opt.port)
      {
         if (isFinite(+opt.port) && opt.port == (0xFFFF & opt.port))
         {
            opt.port <<= 0;
         }
         else
         {
            throw new Error('invalid port');
         }
      }
   }
   if (null !== (r = PEXT.exec(opt.path)))
   {
      pathname  = r[1];
      extention = r[2];
   }
   else
   {
      pathname = opt.path;
   }
   if (void 0 === opt.scheme)
   {
      opt.scheme = (!opt.host && !opt.port
         ? ('' === pathname || '.' === pathname? 'tty' : 'file')
         : 'udp');
   }
   else if (!(opt.scheme in means))
   {
      throw new Error('unsupported protocol');
   }
   let mask = parseLevel(fragment);
   let format;
   if (extention in formats)
   {
      format = formats[extention](opt);
   }

   return streams[uri] = means[opt.scheme](id, mask, opt, format);
};

const newBase = function (id)
{
   if (app.stderr && app.stderr.isTTY)
   {
      let format = formats.tty({});
      return function ()
      {
         app.stderr.write(format(id, 8, arguments) + '\n');
      };
   }
   else return function () { };
};

const getMethod = function (level, bit, streams)
{
   return function ()
   {
      if (0 !== bit)
      {
         if (null !== MASK)
         {
            if (0 === (bit & MASK)) return;
         }
      }
      for (let i = 0; i < streams.length; ++i)
      {
         streams[i].write(level, bit, arguments);
      }
      if (0 === bit)
      {
         app.exit(1);
      }
   };
};

const newLogger = function (id, uris)
{
   if (!(uris instanceof Array))
   {
      if (void 0 === uris || null === uris)
      {
         return dummy;
      }
      else if ('number' === typeof uris)
      {
         uris = String(uris);
      }
      else if ('string' !== typeof uris)
      {
         throw new TypeError('log: invalid uri ' + escape(uris));
      }
      uris = [uris];
   }
   else if (0 === uris.length) return dummy;
   let streams = [];
   for (let i = 0; i < uris.length; ++i)
   {
      if ('string' !== typeof uris[i])
      {
         throw new TypeError('log: invalid uri ' + escape(uris[i]));
      }
      try
      {
         streams.push(getStream(id, uris[i]));
      }
      catch (ex)
      {
         throw new global[ex.name]('log: '
            + escape(ex.message + ' ' + uris[i]));
      }
   }
   let logger = newBase(id);
   logger.emerg   = getMethod(0, log.EMERG,   streams);
   logger.alert   = getMethod(1, log.ALERT,   streams);
   logger.crit    = getMethod(2, log.CRIT,    streams);
   logger.err     = getMethod(3, log.ERR,     streams);
   logger.warning = getMethod(4, log.WARNING, streams);
   logger.notice  = getMethod(5, log.NOTICE,  streams);
   logger.info    = getMethod(6, log.INFO,    streams);
   logger.debug   = getMethod(7, log.DEBUG,   streams);
   Object.freeze(logger.emerg);
   Object.freeze(logger.alert);
   Object.freeze(logger.crit);
   Object.freeze(logger.err);
   Object.freeze(logger.notice);
   Object.freeze(logger.info);
   Object.freeze(logger.debug);

   return Object.freeze(logger);
};

app.on('SIGUSR2', function ()
{
   for (let i in streams)
   {
      try { streams[i].open(true); }
      catch (ex) { log(new Error('log: ' + ex.message)); }
   }
});

const timer = new Timer();
timer.unref();
timer[Timer.kOnTimeout] = function ()
{
   for (let i in streams)
   {
      try { streams[i].open(); }
      catch (ex) { log(new Error('log: ' + ex.message)); }
   }
   this.start(REOPEN);
};
timer.start(REOPEN);
