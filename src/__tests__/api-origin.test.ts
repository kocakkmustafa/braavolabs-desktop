import { it, expect, vi } from 'vitest';
import { apiFetch } from '../client';
import { readFileSync } from 'node:fs';
it.each(['http://remote.test/api/v1','https://user:password@remote.test/api/v1','https://remote.test/api/v1?token=hidden','https://remote.test/api/v1#fragment','file:///tmp/api'])('rejects unsafe API before credentials: %s',async(apiUrl)=>{
 const fetchImpl=vi.fn();await expect(apiFetch('/users/me',{cfg:{apiUrl,token:'secret'},fetchImpl})).rejects.toThrow();expect(fetchImpl).not.toHaveBeenCalled();
});
it('uses redirect:error for bearer and refresh requests',async()=>{
 const fetchImpl=vi.fn().mockResolvedValueOnce({status:401,ok:false}).mockResolvedValueOnce({status:200,ok:true,json:async()=>({token:'rotated',refreshToken:'rotated-refresh'})}).mockResolvedValueOnce({status:200,ok:true,json:async()=>({ok:true})});
 await apiFetch('/users/me',{cfg:{apiUrl:'https://selfhost.test/api/v1',token:'old',refreshToken:'refresh'},fetchImpl,save:()=>{}});
 expect(fetchImpl).toHaveBeenCalledTimes(3);for(const [,options] of fetchImpl.mock.calls)expect(options.redirect).toBe('error');
});
it('rejects endpoint escaping selected API path',async()=>{
 const fetchImpl=vi.fn();await expect(apiFetch('/../../other',{cfg:{apiUrl:'https://selfhost.test/api/v1',token:'secret'},fetchImpl})).rejects.toThrow();expect(fetchImpl).not.toHaveBeenCalled();
});
it('native CSP supports selfhost without broad HTTP',()=>{
 const config=JSON.parse(readFileSync(new URL('../../src-tauri/tauri.conf.json',import.meta.url),'utf8'));const connect=config.app.security.csp.split(';').find((part:string)=>part.trim().startsWith('connect-src'));
 expect(connect).toContain('https:');expect(connect).toContain('http://127.0.0.1:*');expect(connect).toContain('http://localhost:*');expect(connect.split(/\s+/)).not.toContain('http:');
});
