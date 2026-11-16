/* 把 src/ 打成一个自包含的 HTML */
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const rd = (p) => fs.readFileSync(path.join(root, 'src', p), 'utf8');

const css = rd('style.css');
const dsp = rd('dsp.js');
const app = rd('app.js');
let html = rd('index.html');

if (dsp.includes('</script')) throw new Error('dsp.js 含有 </script，无法内联');

html = html.split('/*__CSS__*/').join(css);
html = html.split('/*__DSP__*/').join(dsp);
html = html.split('/*__APP__*/').join(app);

const out = path.join(root, '挂电Studio.html');
fs.writeFileSync(out, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`built -> ${path.basename(out)}  (${kb} KB)`);
