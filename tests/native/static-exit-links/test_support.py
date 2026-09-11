"""Shared paths and fail-closed source-view selection for repository native tests."""
from pathlib import Path
import os
import re

ROOT = Path(os.environ['DOLPHIN_STATIC_LINK_TEST_ROOT']).resolve()
SOURCE = ROOT / 'vendor/dolphin/Source/Core/Core/PowerPC/CachedInterpreter'
COMPILER = os.environ['DOLPHIN_STATIC_LINK_TEST_CXX']
NATIVE_FLAGS = ([] if os.name == 'nt' else ['-pthread']) + ['-I', str(SOURCE)]

_GATES = ('DOLPHIN_WEB_STATIC_EXIT_LINKS', 'DOLPHIN_WEB_STATIC_EXIT_LINK_STATS')


def _expression(expression, links, stats, required=False):
    expression = expression.split('//', 1)[0].strip()
    if not required and not any(name in expression for name in _GATES):
        return None
    values = dict(zip(_GATES, (links, stats)))
    values['__EMSCRIPTEN__'] = True
    tokens = re.findall(r'defined|[A-Za-z_]\w*|\d+|&&|\|\||!|\(|\)', expression)
    assert ''.join(tokens) == re.sub(r'\s+', '', expression), 'Unsupported link gate expression: ' + expression
    position = 0

    def take():
        nonlocal position
        assert position < len(tokens), 'Incomplete link gate expression'
        token = tokens[position]
        position += 1
        return token

    def primary():
        token = take()
        if token == '!': return not primary()
        if token == '(':
            value = either()
            assert take() == ')', 'Unbalanced link gate expression'
            return value
        if token == 'defined':
            name = take()
            if name == '(':
                name = take()
                assert take() == ')', 'Malformed defined() gate'
            assert name in values, 'Unknown macro in link gate: ' + name
            return True  # The fixture explicitly defines both feature gates, even at zero.
        if token.isdecimal(): return int(token) != 0
        assert token in values, 'Unknown macro in link gate: ' + token
        return bool(values[token])

    def both():
        nonlocal position
        value = primary()
        while position < len(tokens) and tokens[position] == '&&':
            position += 1
            right = primary()  # Always parse the right operand.
            value = value and right
        return value

    def either():
        nonlocal position
        value = both()
        while position < len(tokens) and tokens[position] == '||':
            position += 1
            right = both()
            value = value or right
        return value

    result = either()
    assert position == len(tokens), 'Unconsumed link gate expression: ' + expression
    return result


def select_link_gates(text, links, stats=False):
    """Select actual macro-0/1 source arms; never compile baseline under gate 1."""
    stack, output = [], []

    def active(): return all(frame['selected'] for frame in stack)

    for line in text.splitlines(keepends=True):
        match = re.match(r'\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)', line)
        if not match:
            if active(): output.append(line)
            continue
        directive, expression = match[1], match[2].strip()
        if directive in ('if', 'ifdef', 'ifndef'):
            if directive != 'if':
                expression = ('!' if directive == 'ifndef' else '') + 'defined(' + expression + ')'
            value = _expression(expression, links, stats)
            stack.append({'known': value is not None, 'selected': value if value is not None else True,
                          'taken': value if value is not None else False})
            if value is None and active(): output.append(line)
        elif directive == 'elif':
            assert stack, 'Unbalanced #elif'
            frame = stack[-1]
            if frame['known']:
                value = _expression(expression, links, stats, required=True)
                frame['selected'] = not frame['taken'] and value
                frame['taken'] = frame['taken'] or value
            else:
                assert not any(name in expression for name in _GATES), 'Mixed unknown/link #elif chain needs explicit selector support'
                if active(): output.append(line)
        elif directive == 'else':
            assert stack, 'Unbalanced #else'
            if stack[-1]['known']:
                stack[-1]['selected'] = not stack[-1]['taken']
                stack[-1]['taken'] = True
            elif active(): output.append(line)
        else:
            assert stack, 'Unbalanced #endif'
            frame = stack.pop()
            if not frame['known'] and active(): output.append(line)
    assert not stack, 'Unbalanced source conditionals'
    selected = ''.join(output)
    assert not re.search(r'^\s*#\s*(?:if|ifdef|ifndef|elif)\b[^\n]*(?:' + '|'.join(_GATES) + ')', selected, re.M), 'Unresolved link gate in selected source view'
    return selected
