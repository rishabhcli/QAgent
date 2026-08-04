const sensitiveKey = /(authorization|credential|password|secret|token|api[_-]?key)/i;

export function redactDisplayValue(value: unknown, parentKey = ''): unknown {
  if (sensitiveKey.test(parentKey)) return '[REDACTED]';
  if (Array.isArray(value)) {
    return value.map((item) => redactDisplayValue(item));
  }
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (parentKey === 'env' || key === 'env') {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [key, item];
        return [
          key,
          Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((name) => [name, '<configured>'])
          ),
        ];
      }
      return [key, redactDisplayValue(item, key)];
    })
  );
}
