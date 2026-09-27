export const artworkNames = ['dragon-phoenix','dragon-waves','landscape','midnight-dragon','torii-tides','sakura-lake','waterfall-gate','vision-waterfall','mountain-tide','swallow-orbits'] as const;
export const pageInfo:Record<string,{title:string;art:string[]}>={
 '/':{title:'Luminary',art:[...artworkNames]},
 '/protocol':{title:'The protocol',art:['torii-tides','sakura-lake','waterfall-gate']},
 '/technology':{title:'The technology',art:['midnight-dragon','torii-tides','swallow-orbits','landscape','dragon-phoenix']},
 '/auctions':{title:'The rhythm',art:['sakura-lake','torii-tides','midnight-dragon','mountain-tide','swallow-orbits','waterfall-gate']},
 '/vision':{title:'The vision',art:['waterfall-gate','landscape','torii-tides','swallow-orbits','mountain-tide','dragon-phoenix','vision-waterfall']},
 '/dashboard':{title:'Auction terminal',art:['landscape','dragon-waves']},
 '/legal/terms':{title:'Terms of use',art:[]},
 '/legal/privacy':{title:'Privacy notice',art:[]},
 '/legal/risks':{title:'Risk & eligibility',art:[]},
};
export function pagePath(path:string){return path.replace(/\/$/,'')||'/'}
// Native anchors, downloads, external links and same-page navigation stay native.
export function transitionDestination(href:string,base:string,target='',download=false){
 if(download||(target&&target!=='_self'))return null;
 try{const from=new URL(base),to=new URL(href,base);if(to.origin!==from.origin||!['https:','http:'].includes(to.protocol)||pagePath(to.pathname)===pagePath(from.pathname)||!pageInfo[pagePath(to.pathname)])return null;return to}catch{return null}
}
