'use strict';
const I18n = require('../../shared/i18n');

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  I18n.setLanguage(workerData.language);
  parentPort.postMessage(require('./skillScanner').discoverExternalDetailed(workerData));
} else {
  let busy = false;
  module.exports.scan = (options) => {
    if (busy) return Promise.reject(new Error(I18n.t('技能扫描正在进行，请稍后重试')));
    const owner = {};
    busy = owner;
    const release = () => { if (busy === owner) busy = false; };
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(__filename, { workerData: { ...options, language: I18n.language } }); }
      catch (error) { release(); reject(error); return; }
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result);
        // Keep the single-worker slot until termination actually completes.
        worker.terminate().then(release, () => {
          // Keep the slot until exit if the host cannot terminate this worker.
        });
      };
      const timer = setTimeout(() => finish(new Error(I18n.t('技能扫描超时，请选择更具体的本地目录'))), 5000);
      worker.once('message', (result) => finish(null, result));
      worker.once('error', (error) => finish(error));
      worker.once('exit', () => {
        release();
        finish(new Error(I18n.t('技能扫描提前结束，请重试')));
      });
    });
  };
}
