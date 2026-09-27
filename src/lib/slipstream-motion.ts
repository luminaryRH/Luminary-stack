// Belt geometry and fade from the user-supplied slider-slipstream.html.
export const slipstreamConfig={slots:6,cardRatio:1.34,tilt:-32,spacing:.3,cardY:.64,autoScroll:.22,drag:.9,damp:.92,fadeFar:.24,nearHide:.4};
const smoothstep=(a:number,b:number,x:number)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t)};
export function beltPose(index:number,position:number,step:number,slots=slipstreamConfig.slots){const span=step*slots;let x=((index*step+position)%span+span)%span;if(x>span/2)x-=span;const f=x/span,opacity=Math.min(smoothstep(-.5,-.5+slipstreamConfig.fadeFar,f),1-smoothstep(slipstreamConfig.nearHide,.5,f));return{x,opacity,transform:`translateX(${x.toFixed(1)}px)`}}
export function nearestSessionOffset(session:number,position:number,step:number){let delta=Infinity;for(let i=session;i<slipstreamConfig.slots;i+=3){const x=beltPose(i,position,step).x;if(Math.abs(x)<Math.abs(delta))delta=x}return -delta}
