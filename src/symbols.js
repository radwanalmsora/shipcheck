'use strict';
const U = require('./util');

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'new', 'typeof',
  'await', 'async', 'constructor', 'super', 'this', 'import', 'export', 'from', 'require', 'class', 'def', 'elif', 'except',
  'with', 'lambda', 'print', 'assert', 'yield', 'throw', 'delete', 'void', 'in', 'of', 'case', 'default', 'get', 'set', 'static', 'public', 'private', 'protected']);
const GENERIC = new Set(['main', 'init', 'run', 'get', 'set', 'handle', 'render', 'update', 'create', 'delete', 'test', 'setup',
  'constructor', 'index', 'default', 'exports', 'module', 'app', 'data', 'value', 'name', 'id', 'type', 'result', 'start', 'stop',
  'build', 'load', 'save', 'close', 'open', 'read', 'write', 'parse', 'format', 'apply', 'call', 'map', 'filter', 'add', 'remove',
  'config', 'options', 'props', 'state', 'callback', 'next', 'error', 'log', 'help', 'send', 'check', 'validate', 'execute', 'process']);

function declsInLine(text, lang) {
  const out = [];
  const add = (m, kind) => { if (m && m[1] && !KEYWORDS.has(m[1])) out.push({ name: m[1], kind }); };
  switch (lang) {
    case 'js':
      add(text.match(/\bfunction\*?\s+([A-Za-z_$][\w$]*)\s*\(/), 'function');
      add(text.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/), 'function');
      add(text.match(/\bclass\s+([A-Za-z_$][\w$]*)/), 'class');
      add(text.match(/\b(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/), 'type');
      add(text.match(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/), 'function');
      add(text.match(/^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{\s*$/), 'method');
      break;
    case 'py':
      add(text.match(/^\s*(?:async\s+)?def\s+(\w+)/), 'function');
      add(text.match(/^\s*class\s+(\w+)/), 'class');
      break;
    case 'go':
      add(text.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)/), 'function');
      add(text.match(/^type\s+(\w+)\s+(?:struct|interface)/), 'type');
      break;
    case 'rs':
      add(text.match(/\bfn\s+(\w+)/), 'function');
      add(text.match(/\b(?:struct|enum|trait)\s+(\w+)/), 'type');
      break;
    case 'rb':
      add(text.match(/^\s*def\s+(?:self\.)?(\w+[?!]?)/), 'function');
      add(text.match(/^\s*(?:class|module)\s+(\w+)/), 'class');
      break;
    case 'php':
      add(text.match(/\bfunction\s+(\w+)/), 'function');
      add(text.match(/\bclass\s+(\w+)/), 'class');
      break;
    case 'java':
    case 'cs':
      add(text.match(/\b(?:class|interface|enum|record|object|trait)\s+(\w+)/), 'class');
      add(text.match(/\bfun\s+(?:<[^>]*>\s*)?(?:\w+\.)?(\w+)/), 'function');
      add(text.match(/^\s*(?:(?:public|private|protected|internal|static|final|override|virtual|async|abstract|synchronized)\s+)+[\w<>\[\],.? ]+\s+(\w+)\s*\([^;]*$/), 'method');
      break;
    default: break;
  }
  return out;
}

function exportsInLine(text, lang) {
  const out = [];
  let m;
  const push = (name, kind, params) => { if (name) out.push({ name, kind, params: params == null ? null : params }); };
  if (lang === 'js') {
    if ((m = text.match(/^\s*export\s+(?:default\s+)?(?:async\s+)?function\*?\s*([A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/))) push(m[1] || 'default', 'function', m[2]);
    else if ((m = text.match(/^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/))) push(m[1], 'class', '');
    else if ((m = text.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*(?::\s*[^=]+)?=>/))) push(m[1], 'function', m[2] != null ? m[2] : m[3]);
    else if ((m = text.match(/^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/))) push(m[1], 'const', null);
    else if ((m = text.match(/^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/))) push(m[1], 'type', null);
    if ((m = text.match(/\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\w*\s*\(([^)]*)\)|\(([^)]*)\)\s*=>)?/))) push(m[1], 'function', m[2] != null ? m[2] : m[3] != null ? m[3] : null);
    if ((m = text.match(/^\s*module\.exports\s*=\s*\{([^}]*)\}/))) {
      for (const part of m[1].split(',')) { const n = part.split(':')[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) push(n, 'export', null); }
    }
  } else if (lang === 'py') {
    if ((m = text.match(/^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(([^)]*)\)/))) push(m[1], 'function', m[2]);
    else if ((m = text.match(/^class\s+([A-Za-z]\w*)/))) push(m[1], 'class', '');
  } else if (lang === 'go') {
    if ((m = text.match(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*\(([^)]*)\)/))) push(m[1], 'function', m[2]);
    else if ((m = text.match(/^type\s+([A-Z]\w*)\s+/))) push(m[1], 'type', null);
  } else if (lang === 'rs') {
    if ((m = text.match(/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)(?:<[^>]*>)?\s*\(?([^)]*)/))) push(m[1], 'function', /\bfn\b/.test(text) ? m[2] : null);
  } else if (lang === 'java' || lang === 'cs') {
    if ((m = text.match(/^\s*public\s+(?:(?:static|final|abstract|sealed|partial)\s+)*(?:class|interface|enum|record)\s+(\w+)/))) push(m[1], 'class', '');
    else if ((m = text.match(/^\s*public\s+(?:(?:static|final|abstract|override|virtual|async|synchronized)\s+)*[\w<>\[\],.? ]+\s+(\w+)\s*\(([^)]*)\)/))) push(m[1], 'method', m[2]);
  } else if (lang === 'php') {
    if ((m = text.match(/^\s*public\s+(?:static\s+)?function\s+(\w+)\s*\(([^)]*)\)/))) push(m[1], 'method', m[2]);
    else if ((m = text.match(/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/))) push(m[1], 'class', '');
  }
  return out;
}

function paramNames(str) {
  return U.splitParams(str || '').map((p) => p.replace(/\s+/g, ' ').trim());
}
const isOptional = (p) => /=|\?|^\.\.\.|^\*/.test(p);
// returns 'same' | 'compatible' | 'breaking'
function compareParams(oldP, newP) {
  const a = paramNames(oldP); const b = paramNames(newP);
  if (a.join(',') === b.join(',')) return 'same';
  if (b.length >= a.length && a.every((p, i) => p === b[i]) && b.slice(a.length).every(isOptional)) return 'compatible';
  return 'breaking';
}

module.exports = { declsInLine, exportsInLine, compareParams, KEYWORDS, GENERIC };
