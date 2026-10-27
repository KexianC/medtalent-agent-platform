// 使用已安装微信开发者工具的独立编译器，不上传、不登录、不修改工具配置。
// 示例：node scripts/compile-wechat-local.cjs 'D:\微信web开发者工具'
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

async function main() {
  const installation = process.argv[2];
  if (!installation) throw new Error('请提供本机微信开发者工具安装目录。');
  const compiler = path.join(installation, 'code/package.nw/node_modules/wcc-exec');
  const root = path.resolve(__dirname, '../wechat-miniprogram');
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const wxml = app.pages.map((page) => page + '.wxml');
  const wxss = [...app.pages.map((page) => page + '.wxss'), 'app.wxss'];
  for (const [binary, args] of [['wcc.exe', wxml], ['wcsc.exe', ['-js', '-pc', String(app.pages.length), ...wxss]]]) {
    const result = spawnSync(path.join(compiler, binary), args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0 || !result.stdout) throw new Error(binary + ' 编译失败：' + result.stderr);
  }
  const report = { checkedAt: new Date().toISOString(), compiler: 'installed WeChat DevTools WCC/WCSC', wxml: wxml.length, wxss: wxss.length, passed: true, note: '仅模板/样式真实编译；不代表微信帐号、业务域名、模拟器或真机已验收。' };
  const output = path.resolve(__dirname, '../output/wechat');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'compile-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
