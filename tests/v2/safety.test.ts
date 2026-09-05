import { expect, it } from 'vitest';
import { scanFields } from '../../src/core/safety/scanner.js';
it('does not misclassify numeric UUID segments as payment cards',()=>{
 for(const value of ['12345678-1234-4234-abcd-123456789abc','12345678-1234-4234-1234-123456789012',JSON.stringify({request_id:'12345678-1234-4234-abcd-123456789abc'})])expect(()=>scanFields([{path:'/data',value}])).not.toThrow();
});
it.each(['我的银行卡号是4111111111111111请记住','卡号4111 1111 1111 1111','-4111111111111111','12345678-1234-4234-abcd-123456789abc 卡号4111111111111111','4111111111111111','4111-1111-1111-1111','4111 1111 1111 1111','card: 4111-1111-1111-1111.','password=private','sk-proj-abcdefghijklmnopqrstuvwxyz'])('still rejects credential/payment content: %s',value=>{
 expect(()=>scanFields([{path:'/data',value}])).toThrow();
});

it('UUID-shaped credentials remain sensitive to non-payment scanners',()=>{expect(()=>scanFields([{path:'/data',value:'api_key=12345678-1234-4234-abcd-123456789abc'}])).toThrow();});
