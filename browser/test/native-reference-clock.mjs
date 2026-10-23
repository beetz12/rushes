// Test-owned fake media only; never imported by the product bundle.
export async function nativeReferenceClock(seed){
  const within=async(operation,label)=>{let timer;try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timed out')),1500);})]);}finally{clearTimeout(timer);}};
  const result={scope:'Test-only native scalar clock conversion; prescribed unit slope, no callback-arrival or export phase correction',timeOrigin:performance.timeOrigin,crossOriginIsolated,privacyResolutionMs:crossOriginIsolated?0.005:0.1,observations:[],cleanupErrors:[]};
  let source,reader,generator,writer,video,sourceFrame;
  try{
   let base;
   if(seed!==undefined){
    const admissionPageMs=performance.now();
    result.seedAdmission={pageMs:admissionPageMs,ageMs:Number.isFinite(seed?.beforePageMs)?admissionPageMs-seed.beforePageMs:null,
      tokenMatch:seed?.token===globalThis.__rushesNativeClockOwner,originMatch:seed?.timeOrigin===performance.timeOrigin,
      pageOrderValid:Number.isFinite(seed?.afterPageMs)&&Number.isFinite(seed?.beforePageMs)&&seed.beforePageMs>=0&&seed.afterPageMs>=seed.beforePageMs&&admissionPageMs>=seed.afterPageMs};
    if(!seed||seed.kind!=='chromium-cdp-timeticks'||seed.token!==globalThis.__rushesNativeClockOwner
      ||seed.timeOrigin!==performance.timeOrigin||!Number.isSafeInteger(seed.timestampUs)||seed.timestampUs<=60000000
      ||!Number.isSafeInteger(seed.timestampUs+1000000)||!Number.isFinite(seed.beforePageMs)||!Number.isFinite(seed.afterPageMs)
      ||typeof seed.token!=='string'||!seed.token||seed.beforePageMs<0||seed.afterPageMs<seed.beforePageMs
      ||admissionPageMs<seed.afterPageMs||admissionPageMs-seed.beforePageMs>1500)
      throw new Error('Invalid, stale or cross-document native clock seed');
    base=seed.timestampUs;result.sourceScalar={timestampUs:base,source:seed.kind};
   }else{
   source=await within(navigator.mediaDevices.getUserMedia({video:{width:320,height:180},audio:false}),'fake source');
   reader=new MediaStreamTrackProcessor({track:source.getVideoTracks()[0],maxBufferSize:1}).readable.getReader();
   const item=await within(reader.read(),'native fake frame');if(item.done)throw new Error('No source frame');sourceFrame=item.value;
   base=sourceFrame.timestamp;result.sourceScalar={timestampUs:base,format:sourceFrame.format,width:sourceFrame.codedWidth,height:sourceFrame.codedHeight};
   sourceFrame.close();sourceFrame=undefined;await within(reader.cancel(),'clock source retirement');reader=undefined;source.getTracks().forEach(track=>track.stop());source=undefined;
   }
   if(!Number.isSafeInteger(base))throw new Error('Source timestamp is not a safe integer');
   generator=new MediaStreamTrackGenerator({kind:'video'});writer=generator.writable.getWriter();
   video=document.createElement('video');video.muted=true;video.playsInline=true;video.width=16;video.height=16;video.srcObject=new MediaStream([generator]);document.body.append(video);
   const playing=video.play();playing.catch(()=>{});
   const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const drawing=canvas.getContext('2d',{willReadFrequently:true});
   // Delivery handshake for this blank helper only, before any conversion sentinel.
   // A single initial write timed out in the capability control; require delivery before measuring.
   let primerSeen=false,lastProvided=base;
   const primerObserved=new Promise(resolve=>video.requestVideoFrameCallback((callbackNow,metadata)=>{primerSeen=true;resolve({callbackNow,captureTime:metadata.captureTime,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames});}));
   result.primerWrites=[];
   const pump=async()=>{
    for(let index=0;index<10&&!primerSeen;index++){
     lastProvided=base+index*33333;const bytes=new Uint8Array(16*16*4);
     for(let pixel=0;pixel<256;pixel++){bytes[pixel*4]=240;bytes[pixel*4+1]=201;bytes[pixel*4+2]=37;bytes[pixel*4+3]=255;}
     const frame=new VideoFrame(bytes,{format:'RGBA',codedWidth:16,codedHeight:16,timestamp:lastProvided});
     try{await within(writer.write(frame),'primer write');result.primerWrites.push(lastProvided);}finally{frame.close();}
     if(!primerSeen)await new Promise(resolve=>setTimeout(resolve,33));
    }
   };
   await pump();result.primer=await within(primerObserved,'primer delivery');
   await within(playing,'playback ready');
   const sentinelBase=lastProvided+50000;
   for(let index=0;index<3;index++){
    const id=17+index*76,stamp=sentinelBase+index*50000,bytes=new Uint8Array(16*16*4);
    if(!Number.isSafeInteger(stamp))throw new Error('Sentinel timestamp is not a safe integer');
    for(let pixel=0;pixel<256;pixel++){bytes[pixel*4]=id;bytes[pixel*4+1]=201;bytes[pixel*4+2]=37;bytes[pixel*4+3]=255;}
    const observed=new Promise(resolve=>video.requestVideoFrameCallback((callbackNow,metadata)=>{
     drawing.drawImage(video,0,0);const rgba=[...drawing.getImageData(0,0,1,1).data];resolve({callbackNow,metadata:{captureTime:metadata.captureTime,mediaTime:metadata.mediaTime,presentedFrames:metadata.presentedFrames,presentationTime:metadata.presentationTime,expectedDisplayTime:metadata.expectedDisplayTime},rgba});
    }));
    const frame=new VideoFrame(bytes,{format:'RGBA',codedWidth:16,codedHeight:16,timestamp:stamp});
    try{await within(writer.write(frame),'sentinel write');}finally{frame.close();}
    const actual=await within(observed,'sentinel rVFC');result.observations.push({index,id,providedTimestampUs:stamp,...actual});
    if(!Number.isFinite(actual.metadata.captureTime)||actual.metadata.captureTime<=0)throw new Error('rVFC captureTime missing or nonpositive; no scalar conversion');
    if(!Number.isFinite(actual.metadata.mediaTime))throw new Error('Sentinel mediaTime is missing or non-finite');
    if(!Number.isSafeInteger(actual.metadata.presentedFrames)||actual.metadata.presentedFrames<=0)throw new Error('Sentinel presented-frame count is missing or invalid');
    if(Math.abs(actual.metadata.mediaTime*1e6-stamp)>1)throw new Error('Sentinel mediaTime identity mismatch');
    if(Math.abs(actual.rgba[0]-id)>3||Math.abs(actual.rgba[1]-201)>3||Math.abs(actual.rgba[2]-37)>3||actual.rgba[3]!==255)throw new Error('Sentinel pixel identity mismatch');
    if(index&&actual.metadata.presentedFrames<=result.observations[index-1].metadata.presentedFrames)throw new Error('Presented frame identity did not advance');
   }
   await within(playing,'playback ready');
   const r=result.privacyResolutionMs,numericAllowance=Math.max(0.001,Number.EPSILON*Math.max(...result.observations.map(row=>Math.abs(row.providedTimestampUs/1000)))*16);let lower=-Infinity,upper=Infinity;
   for(let index=0;index<result.observations.length;index++){
    const row=result.observations[index],origin=row.providedTimestampUs/1000-row.metadata.captureTime;
    row.originIntervalMs=[origin-r-numericAllowance,origin+r+numericAllowance];lower=Math.max(lower,row.originIntervalMs[0]);upper=Math.min(upper,row.originIntervalMs[1]);
    if(index){const prior=result.observations[index-1];if(Math.abs((row.metadata.captureTime-prior.metadata.captureTime)-(row.providedTimestampUs-prior.providedTimestampUs)/1000)>2*(r+numericAllowance))throw new Error('Prescribed unit slope mismatch');}
   }
   if(lower>upper)throw new Error('Sentinel origin intervals do not intersect');
   result.converter={qualified:true,originIntervalMs:[lower,upper],unitSlope:1,privacyOnlyComparisonBudgetMs:4*r,numericConversionAllowanceMs:numericAllowance,conservativeSameRealmConversionUncertaintyMs:4*r+numericAllowance,arrivalTimeUsed:false,recordedAVPhaseUsed:false,limitation:'Only converts a plausible supplied absolute-TimeTicks scalar; does not establish a source branch or sensor/sample time'};
   return result;
  }catch(error){result.error=String(error.stack||error);return result;}
  finally{
   sourceFrame?.close();try{if(reader)await within(reader.cancel(),'clock reader cleanup');}catch(error){result.cleanupErrors.push(String(error));}source?.getTracks().forEach(track=>track.stop());
   try{if(writer)await within(writer.close(),'clock writer cleanup');}catch(error){result.cleanupErrors.push(String(error));}generator?.stop();if(video){video.pause();video.srcObject=null;video.remove();}
   if(result.cleanupErrors.length)result.error??='Clock helper cleanup: '+result.cleanupErrors.join('; ');
  }

}
