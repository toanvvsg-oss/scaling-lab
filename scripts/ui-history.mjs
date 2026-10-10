// Historical UI regression: controlled pod/endpoint/rate/trace snapshots.
// Requires dashboard, Chrome, playwright-core, and one Ready Prometheus run.
// Read-only: does not create, change, or delete Kubernetes resources.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
const base=process.argv[2] || 'http://127.0.0.1:4173';
await mkdir('results',{recursive:true});const checks=[];
const runs=await fetch(base+'/api/runs').then(r=>r.json());const a=runs.find(r=>r.lesson==='prometheus'&&r.status==='ready');if(!a)throw Error('Need retained run');
const t0=Date.now()-30000,t1=t0+15000;
const points=[
 {at:new Date(t0).toISOString(),actual:2,ready:2,endpoints:2,desired:2,offeredRps:0,achievedRps:0,observedRps:0,podsSnapshot:[{name:'history-before-pod',ready:true,terminating:false}],endpointsSnapshot:[{pod:'history-before-pod',ready:true,terminating:false}]},
 {at:new Date(t1).toISOString(),actual:3,ready:3,endpoints:3,desired:3,offeredRps:15,achievedRps:15,observedRps:15,podsSnapshot:[{name:'history-after-pod',ready:true,terminating:false}],endpointsSnapshot:[{pod:'history-after-pod',ready:true,terminating:false}]},
];
const ev={at:new Date(t1).toISOString(),type:'sample',data:{requestId:'cafef00d123',edgeConnection:'9',appConnection:'13',pod:'history-after-pod',ok:true,ms:2}};
const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
function check(name,pass,detail){checks.push({name,pass,detail});console.log(`${pass?'PASS':'FAIL'} ${name}: ${detail||''}`);}
try{
 await page.route(`**/api/runs/${a.id}/timeline`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({points,milestones:[]})}));
 await page.route(`**/api/runs/${a.id}`,async route=>{const d=await fetch(base+`/api/runs/${a.id}`).then(r=>r.json());d.events=[ev];d.rev=123456;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(d)});});
 await page.goto(base,{waitUntil:'networkidle'});await page.click('.lesson-link[data-index="6"]');await page.waitForSelector(`#run-select option[value="${a.id}"]`,{state:'attached'});await page.selectOption('#run-select',a.id);await page.waitForFunction(id=>window.labRun===id,a.id);await page.waitForTimeout(6000);
 await page.waitForFunction(()=>document.querySelector('#trace').textContent.includes('cafef00d'));
 await page.locator('#timeline-scrub').evaluate((e,t)=>{e.value=String(t);e.dispatchEvent(new Event('input',{bubbles:true}));},t0);await page.waitForTimeout(700);
 check('early cursor shows historical pod',(await page.textContent('#pods')).includes('history-before-pod'));
 check('early cursor shows historical endpoint',(await page.textContent('#endpoints')).includes('history-before-pod'));
 check('early cursor headline uses historical rate',(await page.textContent('#prometheus-rate')).includes('0.0 requests / second'));
 check('early cursor hides later request trace',!(await page.textContent('#trace')).includes('cafef00d'));
 check('early cursor hides later event',!(await page.textContent('#timeline')).includes('history-after-pod'));
 await page.locator('#timeline-scrub').evaluate((e,t)=>{e.value=String(t);e.dispatchEvent(new Event('input',{bubbles:true}));},t1);await page.waitForTimeout(700);
 check('late cursor advances pod snapshot',(await page.textContent('#pods')).includes('history-after-pod'));
 check('late cursor reveals request identity',(await page.textContent('#trace')).includes('cafef00d'));
 await page.click('#timeline-pause');await page.waitForTimeout(2000);
 check('resume restores real current pod list',!(await page.textContent('#pods')).includes('history-'));
 check('no browser errors',errors.length===0,errors.join(';'));
}catch(e){check('history review completes',false,e.message);}
finally{await page.screenshot({path:'results/ui-history.png',fullPage:true}).catch(()=>{});await browser.close();await writeFile('results/ui-history-checks.json',JSON.stringify({kind:'controlled browser history fixture; no cluster mutation',checks},null,2));}
if(checks.some(c=>!c.pass))process.exitCode=1;
