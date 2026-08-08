// Mirror of core ALS so server can enterWith without exporting private ALS from core.
// Storage in db uses core's requireRequestContext — they MUST be the same ALS instance.
// Therefore re-export enter from core by patching core requestContext.
export { enterRequestContext } from '@amem/core';
