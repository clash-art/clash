// @vitest-environment jsdom
import {render,cleanup,waitFor} from '@testing-library/react';
import {expect,test,vi,afterEach} from 'vitest';
const transport=vi.hoisted(()=>({send:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../lib/mcpProject',()=>({sendMcpProjectRequest:transport.send}));
afterEach(()=>{cleanup();vi.clearAllMocks()});
test('MCP project context is headless and never renders an agent control', async()=>{
  const module = await import('./McpProjectContext');
  expect(module).toHaveProperty('McpProjectContext');
  const {McpProjectContext}=module;
  const context='Selected project p, canvas main';
  const {container}=render(<McpProjectContext projectId="p" context={context}/>);
  expect(container.childElementCount).toBe(0);
  await waitFor(()=>expect(transport.send).toHaveBeenCalledWith('p','context',context));
});
