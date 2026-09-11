// @vitest-environment jsdom
import {render,fireEvent,screen,cleanup} from '@testing-library/react';
import {afterEach,expect,test} from 'vitest';
import {AgentAnnotationContextMenu} from './AgentAnnotationContextMenu';
import {AgentSelectionAnnotationOverlay} from './AgentSelectionAnnotationOverlay';
afterEach(()=>{cleanup();delete globalThis.__CLASH_MCP_APP__});
test('MCP mode keeps editor content without the custom agent context menu',()=>{
  globalThis.__CLASH_MCP_APP__=true;
  render(<AgentAnnotationContextMenu target={null} onAnnotate={()=>{throw new Error('Agent GUI must not run')}}><div>Editor content</div></AgentAnnotationContextMenu>);
  fireEvent.contextMenu(screen.getByText('Editor content'));
  expect(screen.queryByRole('menuitem',{name:'Annotate for agent'})).toBeNull();
});
test('MCP mode does not mount the agent selection overlay',()=>{
  globalThis.__CLASH_MCP_APP__=true;
  const {container}=render(<AgentSelectionAnnotationOverlay target={null} annotations={[]} onCreate={()=>{throw new Error('Agent GUI must not run')}}/>);
  expect(container.childElementCount).toBe(0);
});
