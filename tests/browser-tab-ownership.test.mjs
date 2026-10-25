import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { BrowserController } from '../core.mjs';

function fixture(t,initial=[{}]) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'douyin-tab-ownership-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});});
  const pages=[];
  function page(input={}) {
    const value={name:input.name||'',address:input.url||'about:blank',text:input.text||'',elements:input.elements||0,closed:false,navigations:[],writes:[]};
    Object.assign(value,{
      isClosed:()=>value.closed,url:()=>value.address,setDefaultTimeout(){},setDefaultNavigationTimeout(){},
      async evaluate(fn,arg){
        await setImmediate();const window={name:value.name},document={body:{textContent:value.text},querySelectorAll:()=>({length:value.elements})};
        const result=vm.runInNewContext(`(${fn.toString()})(__argument)`,{window,document,__argument:arg});
        if(window.name!==value.name)value.writes.push(window.name);value.name=window.name;return result;
      },
      async goto(url){await setImmediate();value.navigations.push(url);value.address=url;},
      locator:selector=>({waitFor:async()=>{assert.equal(selector,'[data-e2e="im-entry"]');}}),
    });pages.push(value);return value;
  }
  initial.forEach(page);
  const context={pages:()=>[...pages],newPage:async()=>{await setImmediate();return page();}};
  const browser={isConnected:()=>true,contexts:()=>[context]};
  function controller(source){
    const value=new BrowserController({source,controlDirectory:directory});value.browser=browser;
    // 只模拟标签认领与导航完成；不连接浏览器、不读取视频或用户资料。
    value.settle=async()=>({video:{id:'synthetic-ready-video',readyState:4}});return value;
  }
  return {pages,page,context,browser,controller,directory};
}

test('api-chat与api并发遇到同一空白页时各自认领不同标签',async t=>{
  const f=fixture(t),chat=f.controller('api-chat'),watch=f.controller('api'),original=f.pages[0];
  const [chatPage,watchPage]=await Promise.all([chat.connect(),watch.connect()]);
  assert.notEqual(chatPage,watchPage);assert.equal(f.pages.length,2);
  assert.equal(chatPage.name,'deepseek-douyin-api-chat');assert.equal(watchPage.name,'deepseek-douyin-api');
  assert.ok(chatPage===original||watchPage===original);
  assert.equal(chatPage.writes.includes('deepseek-douyin-api'),false);assert.equal(watchPage.writes.includes('deepseek-douyin-api-chat'),false);
});

test('缓存页被其他入口改名后不抢回foreign页，重新创建自己的标签',async t=>{
  const f=fixture(t),controller=f.controller('api'),old=await controller.connect();
  old.name='deepseek-douyin-api-chat';const previousAddress=old.address,previousNavigations=old.navigations.length;
  const replacement=await controller.connect();
  assert.notEqual(replacement,old);assert.equal(replacement.name,'deepseek-douyin-api');
  assert.equal(old.name,'deepseek-douyin-api-chat');assert.equal(old.address,previousAddress);assert.equal(old.navigations.length,previousNavigations);
});

test('已存在多个同名归属页时拒绝任取一个，不导航或重命名',async t=>{
  const f=fixture(t,[{name:'deepseek-douyin-api',url:'https://www.douyin.com/?synthetic=one'},{name:'deepseek-douyin-api',url:'https://www.douyin.com/?synthetic=two'}]),controller=f.controller('api');
  await assert.rejects(controller.connect(),/多个归属相同/);
  assert.equal(f.pages.length,2);assert.ok(f.pages.every(page=>page.navigations.length===0&&page.writes.length===0));
});

test('缓存成功后再出现第二个同名页，下次操作同样拒绝而不沿用旧缓存',async t=>{
  const f=fixture(t),controller=f.controller('api'),cached=await controller.connect();
  f.page({name:'deepseek-douyin-api',url:'https://www.douyin.com/?synthetic=duplicate'});const count=cached.navigations.length;
  await assert.rejects(controller.connect(),/多个归属相同/);assert.equal(cached.navigations.length,count);assert.equal(f.pages.length,2);
});

test('其他入口空白页与含内容的未命名页不能被当成可认领初始页',async t=>{
  const f=fixture(t,[{name:'foreign-synthetic-owner'},{text:'合成页面内容',elements:1}]),original=[...f.pages],controller=f.controller('api-chat');
  const owned=await controller.connect();assert.equal(f.pages.length,3);assert.ok(!original.includes(owned));
  assert.equal(original[0].name,'foreign-synthetic-owner');assert.equal(original[1].name,'');
  assert.ok(original.every(page=>page.navigations.length===0&&page.writes.length===0));
});

test('多个未命名空白页来源不明时新建标签，不随意挑选其中一个',async t=>{
  const f=fixture(t,[{},{}]),original=[...f.pages],owned=await f.controller('api').connect();
  assert.equal(f.pages.length,3);assert.ok(!original.includes(owned));assert.ok(original.every(page=>page.name===''&&page.navigations.length===0));
});

test('verification显式注入的合成缓存页保留例外，绝不据此扩大普通入口归属',async t=>{
  const f=fixture(t,[{name:'synthetic-fixture',url:'https://fixture.invalid/'}]),controller=f.controller('verification');controller.page=f.pages[0];
  assert.equal(await controller.connect(),f.pages[0]);assert.equal(f.pages.length,1);assert.equal(f.pages[0].name,'synthetic-fixture');
  assert.equal(f.pages[0].navigations.length,0);assert.equal(f.pages[0].writes.length,0);
});
