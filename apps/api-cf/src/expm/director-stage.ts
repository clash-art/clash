import * as m from "../../../../packages/shared-types/src/director-stage.js";
export default { fetch() { return new Response(String(Object.keys(m).length)); } };
