/**
 * @file Bash and Zsh shell-completion script generators driven from
 * cli-spec.json. Hidden experimental commands are intentionally excluded
 * from completions: per v5 §"Two key user decisions locked", post-V1
 * surfaces (lifecycle, audit, lessons, agents) must not appear in default
 * help OR in generated completions even when their handlers exist.
 *
 * Children with multi-word names in the spec (e.g., "profile list",
 * "profile use", "profile show") are reassembled into a nested tree so
 * the shell suggests the right subcommand at each level — `config` ->
 * {show, get, set, unset, profile}; `config profile` -> {list, use, show}.
 *
 * Fish and PowerShell completions are V1.1.
 */

import type { CliSpec } from './loader.js';

export type CompletionShell = 'bash' | 'zsh';

export interface CompletionOptions {
  /** Override the bin name (defaults to "atomicmemory"). */
  bin?: string;
}

/**
 * A node in the visible-command tree. The root represents the bare CLI
 * (children are top-level commands); each non-root node represents a
 * command whose direct children are the next argument the shell should
 * suggest after that command.
 */
interface CompletionNode {
  /**
   * Map from this node's direct child segment to the child's subtree.
   * Insertion order is preserved so completions appear spec-order.
   */
  children: Map<string, CompletionNode>;
  /**
   * Optional summary, used by zsh's `_describe` to show one-line help.
   * Empty string when the segment is purely an intermediate prefix
   * (e.g., the "profile" segment under "config").
   */
  summary: string;
}

function makeNode(summary = ''): CompletionNode {
  return { children: new Map(), summary };
}

/**
 * Build the completion tree from the spec's visible commands. Hidden
 * experimental commands are skipped at the top level; their children
 * are not traversed.
 */
export function buildCompletionTree(spec: CliSpec): CompletionNode {
  const root = makeNode();

  for (const cmd of spec.commands) {
    if (cmd.hidden) continue;
    const cmdNode = makeNode(cmd.summary);
    root.children.set(cmd.name, cmdNode);

    for (const child of cmd.children ?? []) {
      const segments = child.name.split(/\s+/);
      let cursor = cmdNode;
      for (let i = 0; i < segments.length - 1; i++) {
        const segment = segments[i]!;
        if (!cursor.children.has(segment)) {
          // Intermediate prefix (e.g., "profile" under "config"); no
          // direct summary because the spec only documents the leaf.
          cursor.children.set(segment, makeNode(''));
        }
        cursor = cursor.children.get(segment)!;
      }
      cursor.children.set(segments[segments.length - 1]!, makeNode(child.summary));
    }
  }

  return root;
}

export function generateCompletion(
  shell: CompletionShell,
  spec: CliSpec,
  opts: CompletionOptions = {},
): string {
  const bin = opts.bin ?? 'atomicmemory';
  const tree = buildCompletionTree(spec);
  switch (shell) {
    case 'bash':
      return generateBashCompletion(bin, tree);
    case 'zsh':
      return generateZshCompletion(bin, tree);
  }
}

function generateBashCompletion(bin: string, tree: CompletionNode): string {
  const topLevel = Array.from(tree.children.keys()).join(' ');
  const nestedArms = renderBashNestedArms(tree, '  ');

  return `# bash completion for ${bin} (generated from cli-spec.json)
_${bin}_completions() {
  local cur cmd1 cmd2
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${topLevel}" -- "$cur") )
    return 0
  fi

  cmd1="\${COMP_WORDS[1]}"
  cmd2="\${COMP_WORDS[2]:-}"

  case "$cmd1" in
${nestedArms}
  esac
}
complete -F _${bin}_completions ${bin}
`;
}

function renderBashNestedArms(root: CompletionNode, indent: string): string {
  const lines: string[] = [];
  for (const [topName, topNode] of root.children) {
    if (topNode.children.size === 0) continue;
    const directNames = Array.from(topNode.children.keys()).join(' ');
    lines.push(`${indent}${topName})`);

    // If any direct child has its own children, emit a nested case for
    // the third token; otherwise just suggest the direct children.
    const hasGrandchildren = Array.from(topNode.children.values()).some(
      (c) => c.children.size > 0,
    );

    if (hasGrandchildren) {
      lines.push(`${indent}  if [ "$COMP_CWORD" -eq 2 ]; then`);
      lines.push(
        `${indent}    COMPREPLY=( $(compgen -W "${directNames}" -- "$cur") )`,
      );
      lines.push(`${indent}    return 0`);
      lines.push(`${indent}  fi`);
      lines.push(`${indent}  case "$cmd2" in`);
      for (const [midName, midNode] of topNode.children) {
        if (midNode.children.size === 0) continue;
        const grandNames = Array.from(midNode.children.keys()).join(' ');
        lines.push(`${indent}    ${midName})`);
        lines.push(
          `${indent}      COMPREPLY=( $(compgen -W "${grandNames}" -- "$cur") )`,
        );
        lines.push(`${indent}      ;;`);
      }
      lines.push(`${indent}  esac`);
    } else {
      lines.push(
        `${indent}  COMPREPLY=( $(compgen -W "${directNames}" -- "$cur") )`,
      );
    }
    lines.push(`${indent}  ;;`);
  }
  return lines.join('\n');
}

function generateZshCompletion(bin: string, tree: CompletionNode): string {
  const topDescribes = Array.from(tree.children.entries())
    .map(([name, node]) => `    '${name}:${escapeZsh(node.summary)}'`)
    .join('\n');

  const middleArms = renderZshNestedArms(tree, '    ');

  return `#compdef ${bin}
# zsh completion for ${bin} (generated from cli-spec.json)
_${bin}() {
  local -a commands
  commands=(
${topDescribes}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands '${bin} command' commands
    return 0
  fi

  case "\${words[2]}" in
${middleArms}
  esac
}
_${bin} "$@"
`;
}

function renderZshNestedArms(root: CompletionNode, indent: string): string {
  const lines: string[] = [];
  for (const [topName, topNode] of root.children) {
    if (topNode.children.size === 0) continue;
    const directNames = Array.from(topNode.children.keys());
    lines.push(`${indent}${topName})`);

    const hasGrandchildren = Array.from(topNode.children.values()).some(
      (c) => c.children.size > 0,
    );

    if (hasGrandchildren) {
      lines.push(`${indent}  if (( CURRENT == 3 )); then`);
      lines.push(
        `${indent}    _values 'subcommand' ${directNames.map((n) => `'${n}'`).join(' ')}`,
      );
      lines.push(`${indent}    return 0`);
      lines.push(`${indent}  fi`);
      lines.push(`${indent}  case "\${words[3]}" in`);
      for (const [midName, midNode] of topNode.children) {
        if (midNode.children.size === 0) continue;
        const grandNames = Array.from(midNode.children.keys());
        lines.push(`${indent}    ${midName})`);
        lines.push(
          `${indent}      _values 'subcommand' ${grandNames.map((n) => `'${n}'`).join(' ')}`,
        );
        lines.push(`${indent}      ;;`);
      }
      lines.push(`${indent}  esac`);
    } else {
      lines.push(
        `${indent}  _values 'subcommand' ${directNames.map((n) => `'${n}'`).join(' ')}`,
      );
    }
    lines.push(`${indent}  ;;`);
  }
  return lines.join('\n');
}

function escapeZsh(s: string): string {
  return s.replace(/'/g, "'\\''");
}
