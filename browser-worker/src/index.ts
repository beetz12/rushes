// Wave-zero module; replaced by the service slice before acceptance.
export default { async fetch(): Promise<Response> { return Response.json({error:{code:'BUILD_IN_PROGRESS',message:'The browser service is not integrated yet.'}},{status:503}); } };
