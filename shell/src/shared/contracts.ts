import {z} from 'zod';
export type Json = null | boolean | number | string | Json[] | {[key:string]:Json};
export const commands = ['ping','version','guide','status','targets','record.start','record.stop','record.pause','record.resume','record.restart','record.discard','record.cancel','record.mute','record.bubble','permissions.check','permissions.request','permissions.settings','camera.preview.start','camera.preview.stop','list','show','verify','edit.get','edit.set','edit.undo','edit.redo','edit.save','edit.discard','export','thumbnail','transcript.get','transcript.run','transcript.edit-plan','transcript.correct','meta.get','chapters.export','captions.export','meta.generate','meta.set','diagnostics','teleprompter.start','teleprompter.stop'] as const;
export const requestSchema = z.object({cmd:z.enum(commands),args:z.record(z.string(),z.json()).default({})}).strict();
export const windowSchema = z.object({action:z.enum(['library','settings','recorder','close','area','bubble-size','move-bubble','relaunch','acknowledgements','quit']),value:z.number().finite().optional(),x:z.number().finite().optional(),y:z.number().finite().optional()}).strict();
export const recordingOptionsSchema = z.object({mode:z.enum(['display','window','area']),source:z.string().max(300),camera:z.string().max(300),mic:z.string().max(300),systemAudio:z.boolean(),countdownSeconds:z.union([z.literal(0),z.literal(3),z.literal(5)]),bubbleSize:z.union([z.literal(160),z.literal(200),z.literal(280)]),area:z.object({x:z.number(),y:z.number(),width:z.number().positive(),height:z.number().positive()}).optional()});
export type RecordingOptions = z.infer<typeof recordingOptionsSchema>;
export const defaultOptions:RecordingOptions={mode:'display',source:'main',camera:'none',mic:'none',systemAudio:false,countdownSeconds:3,bubbleSize:200};
export const cloudSettingsSchema=z.discriminatedUnion('provider',[
  z.object({provider:z.literal('none')}),
  z.object({provider:z.literal('bucket'),endpoint:z.url(),region:z.string().min(1),bucket:z.string().min(1),publicBaseURL:z.url(),accessKeyId:z.string().min(1),secretAccessKey:z.string().min(1),sessionToken:z.string().optional()}),
  z.object({provider:z.literal('worker'),workerURL:z.url(),token:z.string().min(1)})
]);
export type CloudSettings=z.infer<typeof cloudSettingsSchema>;
export type EngineEvent={event:string;[key:string]:unknown};
export interface RushesAPI {
  request(cmd:string,args?:Record<string,unknown>):Promise<any>;
  bootstrap():Promise<{options:RecordingOptions;enginePath:string;packaged:boolean}>;
  saveOptions(options:RecordingOptions):Promise<void>;
  onEvent(listener:(event:EngineEvent)=>void):()=>void;
  window(action:string,value?:number,x?:number,y?:number):Promise<any>;
  exportFile(id:string,preset:string):Promise<any>;
  media(path:string):Promise<string>;
  selectArea(area:{x:number;y:number;width:number;height:number}):Promise<void>;
  reveal(path:string):Promise<void>;
  confirm(message:string):Promise<boolean>;
  cloudSettings():Promise<{provider:string;configured:boolean;encrypted:boolean;publicBaseURL?:string;workerURL?:string}>;
  saveCloudSettings(settings:CloudSettings):Promise<void>;
  testCloud():Promise<any>;
  share(id:string):Promise<{url:string}>;
  copyLink(url:string):Promise<void>;
}
declare global {interface Window {rushes:RushesAPI}}
export function formatDuration(ms:number):string {const seconds=Math.max(0,Math.floor(ms/1000));return `${Math.floor(seconds/60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}`;}
