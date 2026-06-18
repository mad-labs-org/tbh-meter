"""finder.py — achar classe de NOME CURTO (ut/yp/ud) sem o hang do resolver, e o
mecanismo de singleton nn<T> (chegar na instância viva via a classe).

Por que o resolver normal trava em nome < 3 letras: ele varre "ut\\0" em TODA a
memória (milhões de falsos) e re-varre por cada um. Aqui o needle é a string
ISOLADA (\\0ut\\0) buscada SÓ na região de nomes do metadata -> rara. Idêntico ao
validado no monólito (gold vivo)."""

import struct

from config.offsets import Class, Singleton
from shared.memory import scan


def klass_name(reader, inst):
    """Nome da classe de um objeto gerenciado (compare barato, NÃO é name-scan)."""
    if not inst:
        return None
    k = reader.rptr(inst + 0x0)
    return reader.read_cstr(reader.rptr(k + Class.NAME)) if k else None


def find_class_by_name(reader, regions, name, seed_class):
    """Acha a Il2CppClass de `name` (qualquer tamanho, inclusive 2 letras). `seed_class`
    = qualquer classe já resolvida (pra localizar a região de nomes). Retorna K ou None."""
    if not seed_class:
        return None
    name_ptr = reader.rptr(seed_class + Class.NAME)
    if not name_ptr:
        return None
    names_reg = [(b, s) for (b, s) in regions if b <= name_ptr < b + s]
    pat = b"\x00" + name.encode() + b"\x00"
    matches = scan(reader, names_reg, [pat]).get(pat, [])
    str_addrs = sorted(set(m + 1 for m in matches))   # +1 = pula o \0 da frente
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
    """Subclasse nn<T> -> parent (= nn<T>) -> static_fields -> bbwf = instância viva.
    Pra instância singleton, bbwf_from_klass(inst.klass) deve voltar a própria instância."""
    if not klass:
        return None
    par = reader.rptr(klass + Class.PARENT)
    sf = reader.rptr(par + Class.STATIC_FIELDS) if par else None
    return reader.rptr(sf + Singleton.INSTANCE) if sf else None


def find_singleton(reader, regions, name, seed_class):
    """Atalho: classe de `name` -> instância viva (nn<T>). Retorna a instância ou None."""
    return bbwf_from_klass(reader, find_class_by_name(reader, regions, name, seed_class))
