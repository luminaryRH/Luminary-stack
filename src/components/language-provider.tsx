"use client";
import {createContext,useContext,useEffect,useCallback,useMemo,useState,type ReactNode} from 'react';
import {Languages,ChevronDown} from 'lucide-react';
import {usePathname} from '@/lib/navigation';
import {isLanguage,translateValue,translateText,type Language} from '@/lib/i18n';
const LanguageContext=createContext<{language:Language;setLanguage:(value:Language)=>void}>({language:'en',setLanguage:()=>{}});
const titles:Record<string,string>={'/':'Luminary — Private orders. Public conviction.','/protocol':'The protocol — Luminary','/technology':'The technology — Luminary','/auctions':'The rhythm — Luminary','/vision':'The vision — Luminary','/dashboard':'Auction terminal — Luminary','/legal/terms':'Terms of use — Luminary','/legal/privacy':'Privacy notice — Luminary','/legal/risks':'Risk & eligibility — Luminary'};
export function LanguageProvider({children}:{children:ReactNode}){
 const[language,setCurrent]=useState<Language>('en');const pathname=usePathname()||'/';
 useEffect(()=>{try{const saved=localStorage.getItem('luminary_language');if(isLanguage(saved))setCurrent(saved)}catch{}},[]);
 const setLanguage=useCallback((next:Language)=>{setCurrent(next);try{localStorage.setItem('luminary_language',next)}catch{}},[]);
 useEffect(()=>{document.documentElement.lang=language;document.title=translateText(titles[pathname.replace(/\/$/,'')||'/']||titles['/'],language)},[language,pathname]);
 useEffect(()=>{const sync=(event:StorageEvent)=>{if(event.key==='luminary_language'&&isLanguage(event.newValue))setCurrent(event.newValue)};window.addEventListener('storage',sync);return()=>window.removeEventListener('storage',sync)},[]);
 const value=useMemo(()=>({language,setLanguage}),[language,setLanguage]);
 return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}
export function useTranslation(){
 const {language,setLanguage}=useContext(LanguageContext);
 const t=useCallback(<T,>(value:T):T=>translateValue(value,language),[language]);
 const locale=language==='en'?'en-US':language;
 const formatMoney=useCallback((n:number)=>new Intl.NumberFormat(locale,{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n),[locale]);
 return {t,locale,language,setLanguage,formatMoney};
}
export function LanguageSwitcher(){const{language,setLanguage,t}=useTranslation();return <label className="language-switcher"><Languages size={16} aria-hidden="true"/><span className="sr-only">{t('Language')}</span><select aria-label={t('Language')} value={language} onChange={e=>{if(isLanguage(e.target.value))setLanguage(e.target.value)}}><option value="en" lang="en">English</option><option value="zh-CN" lang="zh-CN">中文</option><option value="ja" lang="ja">日本語</option></select><ChevronDown size={12} aria-hidden="true"/></label>}
