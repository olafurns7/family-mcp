import assert from 'node:assert/strict';
import { DominosClient as Reference } from '../../../../packages/dominos-mcp/src/client.ts';
import { DominosClient as Rust, upstream } from './rust-dominos.ts';
import { Provider, setup } from './fixtures.ts';

export async function readParity() {
  const fixture=await setup();
  const providers=[new Provider(),new Provider()];
  const calls: {url:string;method:string;authorization:string|null;body:unknown}[][]=[[],[]];
  const clients=[Reference,Rust].map((Type,index) => new Type(fixture.path,async (url,options)=>{
    calls[index]!.push({url,method:options.method ?? 'GET',authorization:new Headers(options.headers).get('authorization'),body:options.body ?? null});
    const parsed=new URL(url);
    if(parsed.pathname === '/api/addresses')return Response.json([{ID:42,Name:'Test street 7',PostalCode:'100',PostalCodeName:'Test city',secret:'DO-NOT-RETURN'}]);
    if(parsed.pathname.endsWith('/GetAddressStoreWithWaitingTimes'))return Response.json({RefID:'1',WaitingTime:'20',secret:'DO-NOT-RETURN'});
    if(parsed.pathname==='/api/user/getreceipts')return Response.json([{Id:'receipt',Amount:2500,DateOf:'2026-10-10',secret:'DO-NOT-RETURN'}]);
    if(parsed.pathname==='/api/tracker')return Response.json({OrderID:123,OrderState:'Baking',Remaining:10,IsPickup:true,IsTimedOrder:false,secret:'DO-NOT-RETURN'});
    return providers[index]!.request(url,options);
  }));
  const [ts,rust]=clients;
  assert.ok(ts && rust);
  let count=0;
  try {
    const operations=[
      (client: Reference|Rust)=>client.status(),
      (client: Reference|Rust)=>client.profile(),
      (client: Reference|Rust)=>client.stores(),
      (client: Reference|Rust)=>client.searchMenu({}),
      (client: Reference|Rust)=>client.searchMenu({query:'SYNTHETIC',kind:'pizza',offset:0,limit:1}),
      (client: Reference|Rust)=>client.searchMenu({query:'missing',offset:100}),
      (client: Reference|Rust)=>client.menuItem({kind:'pizza',id:'TEST'}),
      (client: Reference|Rust)=>client.addresses('Test & ð'),
      (client: Reference|Rust)=>client.deliveryStore('Test street & ð','100'),
      (client: Reference|Rust)=>client.receipts(),
      (client: Reference|Rust)=>client.tracker(),
    ];
    for(const operation of operations) {
      const result=[await operation(ts),await operation(rust)];
      assert.deepEqual(result[1],result[0]);
      assert.ok(!JSON.stringify(result).includes('DO-NOT-RETURN'));
      count++;
    }
    assert.deepEqual(calls[1],calls[0]);
    for(const mode of ['http','transport','json','schema','redirect','large','menu-missing','menu-incomplete','menu-invalid']) {
      const request=async()=>{
        if(mode==='http')return new Response('secret-error-body',{status:429});
        if(mode==='transport')throw new Error('secret-transport-cause');
        if(mode==='json')return new Response('secret-invalid-json');
        if(mode==='schema')return Response.json({secret:'secret-invalid-schema'});
        if(mode==='redirect')return new Response('',{status:302,headers:{location:'https://example.invalid/secret'}});
        if(mode==='large')return new Response('x'.repeat(8*1024*1024+1));
        if(mode==='menu-missing')return new Response('malicious()');
        if(mode==='menu-incomplete')return new Response('ReactDOM.hydrate({');
        return new Response('ReactDOM.hydrate({menu:malicious()})');
      };
      const fake=await upstream(request);
      const referenceRequest=(url:string,options:RequestInit)=>{
        const parsed=new URL(url);
        const prefix=parsed.hostname==='www.dominos.is' ? '/website' : parsed.hostname==='checkoutshopper-live.adyen.com' ? '/adyen' : '';
        return fetch(`${fake.origin}${prefix}${parsed.pathname}${parsed.search}`,options);
      };
      const clients=[new Reference(fixture.path,referenceRequest),new Rust(fixture.path,request)];
      try {
        const results=[];
        for(const client of clients) {
          try { results.push(await (mode.startsWith('menu-') ? client.searchMenu({}) : client.stores())); }
          catch(error) { results.push((error as Error).message); }
        }
        assert.deepEqual(results[1],results[0],mode);
        assert.ok(!JSON.stringify(results).includes('secret-'));
        count++;
      } finally { await Promise.all(clients.map(client=>client.close())); await fake.close(); }
    }
  } finally { await Promise.all(clients.map(client=>client.close())); await fixture.client.close(); await fixture.home.cleanup(); }
  return count;
}
