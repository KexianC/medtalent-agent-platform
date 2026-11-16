import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { doctorProfiles } from '../src/data/doctorProfiles.ts';
import { doctorExperiences } from '../src/data/doctorExperience.ts';
import { parsePublicDoctorDetail } from '../src/hooks/useDoctorDirectory.ts';

// 仅在内存中导出真实面板；不改生产组件的导出接口，不访问浏览器存储或网络。
const root = fileURLToPath(new URL('../', import.meta.url));
const bundled = await build({
  entryPoints: [path.join(root, 'src/pages/DoctorApp.tsx')], write: false,
  bundle: true, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
  loader: { '.css': 'empty' },
  plugins: [{ name: 'panel-exports', setup(builder) {
    builder.onLoad({ filter: /\/pages\/DoctorApp\.tsx$/ }, async ({ path: filename }) => ({
      contents: await readFile(filename, 'utf8') + '\nexport { HomePanel, ServicesPanel, WellnessProvider, getDoctorCustom };', loader: 'tsx',
    }));
  } }],
});
const module = { exports: {} };
vm.runInThisContext('(function(require,module,exports){' + bundled.outputFiles[0].text + '\n})', {
  filename: path.join(root, 'tests/doctor-config-fallback-render.bundle.cjs'),
})(createRequire(import.meta.url), module, module.exports);
const { HomePanel, ServicesPanel, WellnessProvider } = module.exports;
const noop = () => {};

for (const slug of ['yu-wen', 'fu-junfen']) {
  test(`${slug} homepage without backend config has no expert introduction entry`, () => {
    const doctor = parsePublicDoctorDetail(doctorProfiles.find(item => item.slug === slug));
    // 与 DoctorAppBody 相同：只有存在定制对象才传入 onExpert。
    const { getDoctorCustom } = module.exports;
    assert.ok(getDoctorCustom);
    const markup = renderToStaticMarkup(React.createElement(WellnessProvider, { doctorSlug: slug, doctorName: doctor.name },
      React.createElement(HomePanel, { doctor, experience: doctorExperiences[slug], onAsk: noop, onManage: noop,
        onWellnessOpen: noop, onExpert: getDoctorCustom(doctor) ? noop : undefined })));
    assert.doesNotMatch(markup, /专家介绍|tang-expert-link/);
    assert.ok(markup.includes(doctor.department));
  });
}

test('Fu generic services retain records, account services, reports and all four service plans from ca31cfd', () => {
  const doctor = parsePublicDoctorDetail(doctorProfiles.find(item => item.slug === 'fu-junfen'));
  const markup = renderToStaticMarkup(React.createElement(ServicesPanel, {
    doctor, experience: doctorExperiences[doctor.slug], onAsk: noop, onManage: noop, onTangAction: noop,
  }));
  for (const label of ['填写记录与查看统计', '预约、提醒与人工协助', '本人报告图片与文字核对', '打开清单与记录', ...doctor.services]) {
    assert.ok(markup.includes(label), label);
  }
  assert.equal((markup.match(/打开清单与记录/g) || []).length, 4);
});
