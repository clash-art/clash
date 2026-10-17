import * as m from "../../../../packages/shared-types/src/index.js";
export default { fetch() { return new Response(String(Object.keys(m).length)); } };
