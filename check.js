'use strict';
const fs=require('node:fs');const {spawnSync}=require('node:child_process');
for(const dir of ['src','test'])for(const file of fs.readdirSync(dir))if(file.endsWith('.js')){const r=spawnSync(process.execPath,['--check',`${dir}/${file}`],{stdio:'inherit'});if(r.status)process.exit(r.status);}
console.log('All JavaScript files passed syntax checks.');
