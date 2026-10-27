import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
export function createNativeLoader(globals={},overrides={}) {
  const cache=new Map();
  const context=vm.createContext({console,setTimeout,clearTimeout,setInterval,clearInterval,ArrayBuffer,Uint8Array,DataView,...globals});
  function load(filename) {
    const key=path.resolve(filename);
    if(Object.hasOwn(overrides,key))return overrides[key];
    if(cache.has(key))return cache.get(key).exports;
    const mod={exports:{}};cache.set(key,mod);
    const code=fs.readFileSync(key,'utf8');
    const run=vm.runInContext(`(function(require,module,exports){${code}\n})`,context,{filename:key});
    run(specifier=>{let p=path.resolve(path.dirname(key),specifier);if(!path.extname(p))p+='.js';return load(p);},mod,mod.exports);return mod.exports;
  }
  return load;
}
