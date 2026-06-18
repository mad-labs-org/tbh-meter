"""finder.py — find a SHORT-NAME class (ut/yp/ud) without the resolver's hang, plus the
nn<T> singleton mechanism (reach the live instance via the class).

Why the normal resolver hangs on names < 3 letters: it scans "ut\\0" across ALL of
memory (millions of false hits) and re-scans for each one. Here the needle is the
ISOLATED string (\\0ut\\0) searched ONLY in the metadata name region -> rare. Identical to
what was validated in the monolith (live gold)."""

import struct

from config.offsets import Class, Singleton
from shared.memory import scan


def klass_name(reader, inst):
    """Class name of a managed object (cheap compare, NOT a name-scan)."""
    if not inst:
        return None
    k = reader.rptr(inst + 0x0)
    return reader.read_cstr(reader.rptr(k + Class.NAME)) if k else None


def find_class_by_name(reader, regions, name, seed_class):
    """Find the Il2CppClass for `name` (any length, even 2 letters). `seed_class`
    = any already-resolved class (to locate the name region). Returns K or None."""
    if not seed_class:
        return None
    name_ptr = reader.rptr(seed_class + Class.NAME)
    if not name_ptr:
        return None
    names_reg = [(b, s) for (b, s) in regions if b <= name_ptr < b + s]
    pat = b"\x00" + name.encode() + b"\x00"
    matches = scan(reader, names_reg, [pat]).get(pat, [])
    str_addrs = sorted(set(m + 1 for m in matches))   # +1 = skip the leading \0
    if not str_addrs:
        return None
    needles = {struct.pack("<Q", a): a for a in str_addrs}
    ptrs = scan(reader, regions, list(needles.keys()), aligned=True)
    for nd in needles:
        for P in ptrs.get(nd, []):
            K = P - Class.NAME
            if (reader.rptr(K + Class.ELEMENT_CLASS) == K or reader.rptr(K + Class.CAST_CLASS) == K) and \
                    reader.read_cstr(reader.rptr(K + Class.NAME)) == name:
                return K
    return None


def bbwf_from_klass(reader, klass):
    """Subclass nn<T> -> parent (= nn<T>) -> static_fields -> bbwf = live instance.
    For a singleton instance, bbwf_from_klass(inst.klass) should return that same instance."""
    if not klass:
        return None
    par = reader.rptr(klass + Class.PARENT)
    sf = reader.rptr(par + Class.STATIC_FIELDS) if par else None
    return reader.rptr(sf + Singleton.INSTANCE) if sf else None


def find_singleton(reader, regions, name, seed_class):
    """Shortcut: class for `name` -> live instance (nn<T>). Returns the instance or None."""
    return bbwf_from_klass(reader, find_class_by_name(reader, regions, name, seed_class))
