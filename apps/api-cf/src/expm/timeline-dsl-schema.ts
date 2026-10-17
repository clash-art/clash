import * as m from "../../../../packages/shared-types/src/timeline-dsl-schema.js";
export default { fetch() { return new Response(String(Object.keys(m).length)); } };
