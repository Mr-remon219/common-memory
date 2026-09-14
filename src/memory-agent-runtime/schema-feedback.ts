import { Errors } from 'typebox/value';
import type { TSchema } from 'typebox';

const names=new Set(['version','request_id','decisions','edit_result','kind','applicability','confidence','evidence','reason','admission','lifetime','operations','op','target','section','title','body','handle','block','offset','notes','name']);
const rules=new Set(['required','additionalProperties','type','const','enum','minimum','maximum','minItems','maxItems','minLength','maxLength','anyOf']);
export interface SchemaFeedback {path:string;rule:string;properties?:string[]}
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
/** Repair hints only, never validation authority. No values, arbitrary keys, or error prose escape. */
export function schemaFeedback(schema:TSchema,value:unknown):SchemaFeedback[] {
  try {
    const properties=object(object(schema)?.properties),decisionArray=object(properties?.decisions),items=object(decisionArray?.items);
    const decisions=object(value)?.decisions,alternatives=items?.anyOf;
    const discriminated=Array.isArray(alternatives)&&Array.isArray(decisions);
    const root=discriminated?{...schema,properties:{...properties,decisions:{...decisionArray,items:{}}}}:schema;
    const errors=Errors(root as TSchema,value);
    if(discriminated)for(const [index,decision] of decisions.slice(0,128).entries()){
      const kind=object(decision)?.kind;
      const branch=alternatives.find(candidate=>object(object(object(candidate)?.properties)?.kind)?.const===kind);
      if(branch)errors.push(...Errors(branch as TSchema,decision).map(error=>({...error,instancePath:`/decisions/${index}${error.instancePath}`})));
      else errors.push({keyword:'enum',instancePath:`/decisions/${index}/kind`,schemaPath:'',params:{allowedValues:[]},message:''});
    }
    const feedback:SchemaFeedback[]=[];
    for(const error of errors){
      if(!rules.has(error.keyword))continue;
      const path=error.instancePath;
      if(path.length>256||path.split('/').slice(1).some(part=>!names.has(part)&&!/^(?:0|[1-9][0-9]{0,5})$/u.test(part)))continue;
      const params=object(error.params),raw=params?.requiredProperties??params?.additionalProperties;
      const fields=Array.isArray(raw)?raw.filter((field):field is string=>typeof field==='string'&&names.has(field)):[];
      const hint={path,rule:error.keyword,...(fields.length?{properties:[...new Set(fields)].slice(0,16)}:{})};
      if(!feedback.some(item=>JSON.stringify(item)===JSON.stringify(hint)))feedback.push(hint);
      if(feedback.length===12)break;
    }
    return feedback;
  }catch{return [];}
}
