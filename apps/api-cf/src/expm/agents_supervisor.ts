import * as m from "../agents/supervisor";
export default { fetch() { return new Response(String(Object.keys(m).length)); } };
