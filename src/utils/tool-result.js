// Copy-safe paths at the protocol boundary; keep native paths internally.
export function normalizeToolResult(result) {
  if (!Array.isArray(result?.content)) return result;
  return {
    ...result,
    content: result.content.map(content => {
      if (content.type !== 'text') return content;
      let value;
      try { value = JSON.parse(content.text); } catch { return content; }
      return {
        ...content,
        text: JSON.stringify(value, (_key, item) => {
          if (typeof item === 'string' && (/^[a-z]:\\/i.test(item) || item.startsWith('\\\\'))) {
            return item.replaceAll('\\', '/');
          }
          return item;
        }, 2),
      };
    }),
  };
}
