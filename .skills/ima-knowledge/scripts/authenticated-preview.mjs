import {fetchPreviewBlob} from './preview-response.mjs';

// Use the SAME Supabase client instance as login; never construct another client.
export async function sessionHeaders(supabase, anonKey) {
 const {data,error}=await supabase.auth.getSession();
 if(error) throw error;
 const token=data?.session?.access_token;
 if(!token || token===anonKey) throw new Error('LOGIN_REQUIRED');
 return {apikey:anonKey,Authorization:`Bearer ${token}`};
}

// Preview and download share this entry point. No token captured at module load.
export async function authenticatedPreview({supabase,anonKey,endpoint,mediaId,signal,fetchImpl}) {
 const headers=await sessionHeaders(supabase,anonKey);
 return fetchPreviewBlob({endpoint,mediaId,headers,signal,fetchImpl});
}
