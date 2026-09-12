import { sanitizeDiagnostic } from '../memory-manager/contracts/diagnostic.js';

/** Bounded local diagnostics: never print exception messages, paths, input or credentials. */
export function piDiagnosticReporter(): (phase:'capture'|'maintenance',error:unknown)=>void {
  const reported=new Set<string>();
  return (phase,error)=>{
    const diagnostic=sanitizeDiagnostic(error && typeof error==='object' && 'diagnostic' in error ? error.diagnostic : null);
    const code=diagnostic?`${diagnostic.stage}/${diagnostic.reason}`
      : error instanceof Error && error.message==='CAPTURE_NOT_AUTHORIZED'?'not_authorized'
      : error instanceof Error && error.message==='NOT_CONFIGURED'?'not_configured':'local_configuration_or_storage';
    const key=`${phase}:${code}`;
    if(reported.has(key)||reported.size>=8)return;
    reported.add(key);
    const action=diagnostic?.stage==='network_config'?'Check common-memory config --network, then restart Pi and explicitly retry retained work.'
      : code==='not_authorized'?'Review disclosure.allowedProvenance; capture requires user_explicit authorization.'
      : 'Run common-memory status; check configuration, API key availability and local storage permissions, then restart Pi.';
    process.stderr.write(`[common-memory] ${phase} unavailable (${code}). ${phase==='maintenance'?'Durable work retained. ':''}${action} Repeated identical diagnostics are suppressed.\n`);
  };
}
