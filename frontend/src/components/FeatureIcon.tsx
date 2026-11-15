export function FeatureIcon({feature,size=18}:{feature:string;size?:number}) {
switch(feature){
case "chat": return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
            <path
              fill="currentColor"
              d="M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 4V6a2 2 0 0 1 2-2zm3 5v2h10V9H7zm0 4v2h7v-2H7z"
            />
          </svg>;
case "literature": return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
            <path
              fill="currentColor"
              d="M6 3h9a3 3 0 0 1 3 3v14.5a.5.5 0 0 1-.8.4L14 18.2l-3.2 2.7a.5.5 0 0 1-.8-.4V6a1 1 0 0 0-1-1H6a1 1 0 0 0-1 1v12H3V6a3 3 0 0 1 3-3zm10 2h-1v12.6l1.5-1.2a1 1 0 0 1 1.2 0l1.3 1V6a1 1 0 0 0-1-1z"
            />
          </svg>;
case "image": return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="1.5" y="2" width="10" height="9" rx="1" />
            <circle cx="4.3" cy="4.8" r=".7" fill="currentColor" stroke="none" />
            <path d="m2 9 3-3 2.5 2L9 6.5l2.5 3.5" strokeWidth="1.4" />
            <path d="M2 22 22 2" />
            <path d="M13 15v-2h9v2M17.5 13v9M15 22h5" />
          </svg>;
case "speech": return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="4" y="1.5" width="4" height="7" rx="2" />
            <path d="M1.5 6.5V8a4.5 4.5 0 0 0 9 0V6.5M6 12.5V14M4 14h4" />
            <path d="M2 22 22 2" />
            <path d="M13 15v-2h9v2M17.5 13v9M15 22h5" />
          </svg>;
case "text": return <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden>
            <path
              fill="currentColor"
              d="M4 5h9v2H4V5zm0 4h16v2H4V9zm0 4h11v2H4v-2zm0 4h16v2H4v-2zm14.5-12.5L20 6l-1.5 1.5L17 6l1.5-1.5zM17 11.5 18.5 13 17 14.5 15.5 13 17 11.5z"
            />
          </svg>;
case "unity": return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M7 7h10c2 0 3 2 3.5 4l1 6c.5 3-2 4-4 2l-3-3h-5l-3 3c-2 2-4.5 1-4-2l1-6C4 9 5 7 7 7Z" />
            <path d="M7 10v5m-2.5-2.5h5M16 11h.01M19 14h.01" />
          </svg>;
default:return null;
}
}
