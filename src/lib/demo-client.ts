import {applyAction,initialState,type DemoState} from './market.ts';

// Portable demonstration only. The original hosted D1 backend is included in reference/.
let database:Promise<IDBDatabase>|undefined;
function openPortfolio(){
 return database??=new Promise<IDBDatabase>((resolve,reject)=>{
  const request=indexedDB.open('luminary-portfolio',1);
  request.onupgradeneeded=()=>{request.result.createObjectStore('portfolio')};
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>{db.close();database=undefined};resolve(db)};
  request.onerror=()=>{database=undefined;reject(request.error)};
 });
}
export async function requestDemo(_url:string,init?:RequestInit):Promise<Response>{
 let payload:Record<string,unknown>|undefined;
 if(init?.method==='POST'){
  try{const value=JSON.parse(String(init.body));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();payload=value}catch{return Response.json({error:'Invalid request.'},{status:400})}
 }
 try{
  const db=await openPortfolio();
  return await new Promise<Response>((resolve,reject)=>{
   // A read/write transaction serializes concurrent actions across tabs.
   const transaction=db.transaction('portfolio',payload?'readwrite':'readonly');
   const store=transaction.objectStore('portfolio');const request=store.get('current');let response:Response;
   request.onsuccess=()=>{
    const state=(request.result as DemoState|undefined)??initialState();
    if(!payload){response=Response.json({state});return}
    try{const result=applyAction(state,payload);store.put(result.state,'current');response=Response.json(result)}catch(error){response=Response.json({error:error instanceof Error?error.message:'Check your input.'},{status:400})}
   };
   transaction.oncomplete=()=>resolve(response);
   transaction.onerror=()=>reject(transaction.error);transaction.onabort=()=>reject(transaction.error);
  });
 }catch{return Response.json({error:'Your portfolio could not load. Please try again shortly.'},{status:503})}
}
