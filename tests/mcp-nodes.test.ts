import { describe, expect, it } from 'vitest';
import { extractMcpNodes } from '../src/mcp/nodes';

const literal = (value: unknown) => ({ expression: { type: 'Literal', value } });

describe('extractMcpNodes', () => {
  it('reads inputs.* Literal ids and tools', () => {
    const graph = {
      activities: [
        {
          type: 'ElsaServer.Activities.GmailMCP',
          inputs: { mcpServerId: literal(4), mcpServerName: literal('ZohoDesk MCP'), toolName: literal('search_threads'), toolNames: literal(['a', 'b']) },
        },
      ],
    };
    const { nodes, webRequestNodes } = extractMcpNodes(graph, 'WF');
    expect(webRequestNodes).toBe(0);
    expect(nodes).toEqual([{ workflow: 'WF', serverId: 4, serverName: 'ZohoDesk MCP', tool: 'search_threads', toolNames: ['a', 'b'] }]);
  });
  it('reads the older direct-on-activity shape too', () => {
    const graph = { root: { type: 'x-mcp-bridge', mcpServerId: literal('4'), toolName: literal('t') } };
    const { nodes } = extractMcpNodes(graph, 'WF');
    expect(nodes[0]).toMatchObject({ serverId: 4, tool: 't' });
  });
  it.each([
    ['numeric string', '7', 7],
    ['text id (asana)', 'asana', 'asana'],
    ['absent', undefined, undefined],
    ['empty string', '', undefined],
    ['null', null, undefined],
  ])('%s id is handled without throwing (%s)', (_label, value, expected) => {
    const graph = { type: 'ElsaServer.Activities.GmailMCP', inputs: value === undefined ? {} : { mcpServerId: literal(value), toolName: literal('t') } };
    const { nodes } = extractMcpNodes(graph, 'WF');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.serverId).toBe(expected);
  });
  it('flags non-Literal expression types instead of guessing', () => {
    const graph = {
      type: 'ElsaServer.Activities.GmailMCP',
      inputs: { mcpServerId: { expression: { type: 'Variable', value: 'sid' } }, toolName: literal('t') },
    };
    const { nodes } = extractMcpNodes(graph, 'WF');
    expect(nodes[0]).toMatchObject({ nonLiteral: true });
  });
  it('counts WebRequest nodes and never extracts them', () => {
    const graph = {
      items: [
        { type: 'Elsa.HttpWebRequest', inputs: {} },
        { type: 'ElsaServer.Activities.GmailMCP', inputs: { mcpServerId: literal(1), toolName: literal('t') } },
      ],
    };
    const { nodes, webRequestNodes } = extractMcpNodes(graph, 'WF');
    expect(webRequestNodes).toBe(1);
    expect(nodes).toHaveLength(1);
  });
  it('never throws on odd graphs', () => {
    for (const g of [null, 7, 'mcp', [null, 'x', 3], { type: 'mcp', inputs: null }, { type: 'mcp', inputs: { mcpServerId: { expression: null } } }]) {
      expect(() => extractMcpNodes(g, 'WF')).not.toThrow();
    }
  });
});
