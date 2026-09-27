import catalog from './catalog.json' with {type:'json'};
export type Language='en'|'zh-CN'|'ja';
export const languages:Language[]=['en','zh-CN','ja'];
export function isLanguage(value:unknown):value is Language{return languages.includes(value as Language)}
const entries=catalog as Record<string,string[]>;
const normalized=new Map(Object.entries(entries).map(([k,v])=>[k.trim().toLowerCase(),v]));
const patterns:[RegExp,string,string][]=[
 [/^Enter a number greater than 0 and no more than (.+)\.$/,'请输入大于 0 且不超过 $1 的数字。','0 より大きく、$1 以下の数値を入力してください。'],
 [/^(.+) added to your treasury balance\.$/,'已向模拟国债余额添加 $1。','デモの国債残高に $1 を追加しました。'],
 [/^(.+) withdrawn from your balance\.$/,'已从模拟账户提取 $1。','デモ口座から $1 を出金しました。'],
 [/^(\d+) orders? settled in the call\.$/,'本次模拟竞价已结算 $1 笔订单。','今回の模擬オークションで $1 件の注文を決済しました。'],
 [/^Available to withdraw: (.+)\. Reserved collateral stays with your open orders\.$/,'可提取金额：$1。预留抵押品仍用于您的未完成订单。','出金可能額：$1。未約定注文の担保は引き続き確保されます。'],
 [/^Trade (.+)$/,'交易 $1','$1 を取引'],
 [/^Our (.+) channel is taking shape\.$/,'我们的 $1 频道正在筹备中。','$1 チャンネルを準備しています。'],
];
export function translateText(text:string,language:Language):string{
 if(language==='en'||!text.trim())return text;
 const core=text.trim(),index=language==='zh-CN'?0:1;
 const found=entries[core]||normalized.get(core.toLowerCase());
 let result=found?.[index];
 if(!result){for(const [regex,zh,ja]of patterns){if(regex.test(core)){result=core.replace(regex,index===0?zh:ja);break}}}
 if(!result)return text;
 return text.slice(0,text.length-text.trimStart().length)+result+text.slice(text.trimEnd().length);
}
export function translateValue<T>(value:T,language:Language):T{
 if(typeof value==='string')return translateText(value,language) as T;
 if(Array.isArray(value))return value.map(v=>translateValue(v,language)) as T;
 return value;
}
