"use client";
import {useEffect,useRef,useState,type CSSProperties} from 'react';
import {usePathname,useRouter} from '@/lib/navigation';
import {useTranslation} from '@/components/language-provider';
import {artworkNames,pageInfo,pagePath,transitionDestination} from '@/lib/page-experience';

const decodedArt=new Map<string,Promise<void>>();
function warmArtwork(name:string,priority:'high'|'low'='low'){
 const cached=decodedArt.get(name);if(cached)return cached;
 const image=new Image();image.loading='eager';image.decoding='async';image.fetchPriority=priority;image.src=`/art/${name}.webp`;
 const task=image.decode().catch(()=>{decodedArt.delete(name)});decodedArt.set(name,task);return task;
}
function readyArtwork(path:string){return Promise.all((pageInfo[pagePath(path)]?.art||[]).map((name,i)=>warmArtwork(name,i===0?'high':'low')))}
type Phase='intro'|'idle'|'cover'|'reveal';
export default function PageTransition(){
 const pathname=usePathname()||'/',router=useRouter(),{t}=useTranslation();
 const [scene,setScene]=useState<{phase:Phase;title:string}>({phase:'intro',title:'Luminary'});
 const phase=useRef<Phase>('intro'),pending=useRef<{path:string;cover:Promise<void>;sequence:number;restore:boolean}|null>(null);
 const sequence=useRef(0),previous=useRef(pathname),fallback=useRef<ReturnType<typeof setTimeout>|null>(null);
 const prefetched=useRef(new Set<string>());
 const show=(next:Phase,title?:string)=>{phase.current=next;setScene(s=>({phase:next,title:title??s.title}))};
 useEffect(()=>{
  // Start every artwork request immediately, not when a card enters the viewport.
  void readyArtwork(pathname);artworkNames.forEach(name=>{void warmArtwork(name)});void warmArtwork('emblem','high');
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)show('idle');
  const begin=(path:string,restore=false)=>{const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;const ticket=++sequence.current;pending.current={path,sequence:ticket,restore,cover:new Promise(resolve=>setTimeout(resolve,reduced?0:900))};show('cover',pageInfo[pagePath(path)]?.title||'Luminary');void readyArtwork(path);if(fallback.current)clearTimeout(fallback.current);fallback.current=setTimeout(()=>{if(sequence.current===ticket){pending.current=null;show('idle')}},8000)};
  const anchor=(target:EventTarget|null)=>target instanceof Element?target.closest<HTMLAnchorElement>('a[href]'):null;
  const destination=(a:HTMLAnchorElement)=>transitionDestination(a.href,location.href,a.target,a.hasAttribute('download'));
  const prefetch=(event:Event)=>{const a=anchor(event.target);if(!a)return;const to=destination(a);if(!to)return;void readyArtwork(to.pathname);const href=to.pathname+to.search;if(!prefetched.current.has(href)){prefetched.current.add(href);router.prefetch(href)}};
  const click=(event:MouseEvent)=>{if(event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const a=anchor(event.target);if(!a)return;const to=destination(a);if(!to)return;event.preventDefault();begin(to.pathname);router.push(to.pathname+to.search+to.hash)};
  const back=()=>{if(pagePath(location.pathname)!==pagePath(previous.current))begin(location.pathname,true)};
  document.addEventListener('click',click);document.addEventListener('pointerover',prefetch,{passive:true});document.addEventListener('focusin',prefetch);document.addEventListener('touchstart',prefetch,{passive:true});window.addEventListener('popstate',back);
  return()=>{document.removeEventListener('click',click);document.removeEventListener('pointerover',prefetch);document.removeEventListener('focusin',prefetch);document.removeEventListener('touchstart',prefetch);window.removeEventListener('popstate',back);if(fallback.current)clearTimeout(fallback.current)};
 },[router]);
 useEffect(()=>{
  if(previous.current===pathname)return;previous.current=pathname;
  const task=pending.current;
  if(!task){show('reveal',pageInfo[pagePath(pathname)]?.title||'Luminary');return}
  let cancelled=false;
  // Decode ahead of the reveal. A missing resource must never trap navigation.
  let timeout:ReturnType<typeof setTimeout>;
  const deadline=new Promise<void>(resolve=>{timeout=setTimeout(resolve,3000)});
  void Promise.all([task.cover,Promise.race([readyArtwork(pathname),deadline])]).then(()=>{
   clearTimeout(timeout);if(cancelled||sequence.current!==task.sequence)return;
   if(fallback.current)clearTimeout(fallback.current);pending.current=null;show(matchMedia('(prefers-reduced-motion: reduce)').matches?'idle':'reveal');
   if(!task.restore&&!location.hash){window.scrollTo({top:0,behavior:'instant'});const title=document.querySelector<HTMLElement>('main h1');if(title){title.setAttribute('tabindex','-1');title.focus({preventScroll:true})}}
  });
  return()=>{cancelled=true;clearTimeout(timeout)};
 },[pathname]);
 return <><div className="page-transition" data-phase={scene.phase} aria-hidden="true" onAnimationEnd={event=>{if((phase.current==='intro'||phase.current==='reveal')&&event.animationName==='transit-release'){show('idle')}}}>
  <div className="transit-panels">{[0,1,2,3,4].map(i=><div key={i} className="transit-panel" style={{'--panel':i} as CSSProperties}><i/></div>)}</div>
  <div className="transit-label"><span className="transit-index">{t("LUMINARY")} / 4663</span><strong className="calligraphy">{t(scene.title)}</strong><span className="transit-line"/></div>
  <div className="transit-scan"/>
 </div><span className="sr-only" role="status" aria-live="polite">{scene.phase==='cover'?`${t('Opening')} ${t(scene.title)}`:''}</span></>;
}
