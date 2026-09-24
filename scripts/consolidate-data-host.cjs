'use strict';
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { planConsolidation, applyConsolidation } = require('./consolidate-data');
const args = process.argv.slice(2);
const read = name => args[args.indexOf(name) + 1];
if (!args.includes('--destination') || !args.includes('--source') || !args.includes('--backup')) throw new Error('迁移参数缺失');
app.setName('Chorus');
fs.mkdirSync(path.resolve(read('--destination')), { recursive: true });
app.setPath('userData', fs.realpathSync(read('--destination')));
if (!app.requestSingleInstanceLock()) {
  console.error('Chorus 正在使用目标数据，请正常关闭后重试'); app.exit(1);
} else {
  app.whenReady().then(() => {
    try {
      const result = applyConsolidation(planConsolidation(read('--source'), read('--destination')), read('--backup'), { destinationSingletonHeld: true });
      console.log(JSON.stringify(result, null, 2)); app.exit(0);
    } catch (error) { console.error(error.message); app.exit(1); }
  });
}
