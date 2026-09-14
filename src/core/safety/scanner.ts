import { CoreError } from "../contracts/errors.js";
import { ALWAYS_REJECT_RULES } from "./rules.js";
import { irreversibleFingerprint } from "./redaction.js";

export interface SafetyField { path: string; value: string }
export interface SafetyViolation { rule_id: string; field_path: string; fingerprint: string }
export function scanFields(fields: readonly SafetyField[], _agentInference = false): void {
  const violations: SafetyViolation[] = [];
  for (const field of fields) {
    for (const rule of ALWAYS_REJECT_RULES) {
      let text = field.value;
      if (rule.id === 'secret.credential') {
        // Exact closed placeholders only; other rules still inspect the original.
        text = redactPlaceholders(text);
      }
      let matched: boolean;
      if (rule.id === 'payment.card') {
        text = text.replace(/(?<![A-Za-z0-9_])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![A-Za-z0-9_])/giu,'[uuid]');
        matched = /(?:银行卡|卡号|credit card|card number)\s*(?:[:：=]|是|为)?\s*[0-9][0-9 -]{11,}/iu.test(text) || containsCard(text);
      } else if (rule.id === 'identity.government_id') {
        matched = /身份证(?:号)?\s*(?:[:：=]|是|为)?\s*[0-9Xx]{8,}/u.test(text)
          || [...text.matchAll(/(?<![A-Za-z0-9_])\d{17}[0-9Xx](?![A-Za-z0-9_])/gu)].some(m=>nationalId(m[0]));
      } else matched = rule.pattern.test(text);
      if (matched) violations.push({rule_id:rule.id,field_path:field.path,fingerprint:irreversibleFingerprint(field.value)});
    }
  }
  if (violations.length) throw new CoreError("SENSITIVE_CONTENT_REJECTED", "Content policy rejected the candidate", { violations });
}
function redactPlaceholders(text:string):string {
  // Tool pages are JSON-encoded once. Recognize encoded string/line endings only
  // inside valid JSON, without discarding duplicate keys or any original text.
  let serialized=false;
  if(text.length<=1_048_576)try{const value:unknown=JSON.parse(text);serialized=value!==null&&typeof value==='object';}catch{/* ordinary text */}
  return text.replace(/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|cookie|session[_ -]?secret|recovery code|助记词|密码|私钥)\s*[:=：]\s*(?:\[REDACTED\]|<REDACTED>|\[已脱敏\])/giu,(match:string,offset:number)=>{
    const tail=text.slice(offset+match.length);
    return !tail || /^(?:["']?(?:\s|$))/u.test(tail) || serialized&&/^(?:\\[rn]|"\s*[,}\]])/u.test(tail)?'[redacted assignment]':match;
  });
}
function containsCard(text:string):boolean {
  // Test token-bounded windows: a neighboring number must not hide a card.
  for(const match of text.matchAll(/(?<![A-Za-z0-9_])\d+(?:[ -]+\d+)*(?![A-Za-z0-9_])/gu)) {
    const tokens=match[0].split(/[ -]+/u);
    for(let first=0;first<tokens.length;first++) {
      let digits='';
      for(let last=first;last<tokens.length;last++) {
        digits+=tokens[last];if(digits.length>19)break;
        if(digits.length>=13 && luhn(digits))return true;
      }
    }
  }
  return false;
}
function luhn(digits:string):boolean {
  if (/^(\d)\1+$/u.test(digits)) return false;
  let sum=0;
  for(let i=digits.length-1,alternate=false;i>=0;i--,alternate=!alternate){let n=Number(digits[i]);if(alternate){n*=2;if(n>9)n-=9;}sum+=n;}
  return sum%10===0;
}
/** GB 11643 date and MOD 11-2 checksum; labelled IDs remain conservatively rejected. */
function nationalId(value:string):boolean {
  const date=value.slice(6,14),year=Number(date.slice(0,4)),month=Number(date.slice(4,6)),day=Number(date.slice(6));
  if(year<1800 || month<1 || month>12 || day<1 || day>new Date(Date.UTC(year,month,0)).getUTCDate())return false;
  const weights=[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2];
  return '10X98765432'[weights.reduce((sum,w,i)=>sum+w*Number(value[i]),0)%11]===value[17]!.toUpperCase();
}
