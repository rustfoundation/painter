use llvm_ir::{Module, TypeRef};
use std::collections::{HashMap, HashSet};

/// Allows you to iterate over all the functions in the analyzed `Module`(s) that
/// have a specified type.
///
/// To construct a `FunctionsByType`, use [`ModuleAnalysis`](struct.ModuleAnalysis.html)
/// or [`CrossModuleAnalysis`](struct.CrossModuleAnalysis.html).
pub struct FunctionsByType<'m> {
    map: HashMap<TypeRef, HashSet<&'m str>>,
}

impl<'m> FunctionsByType<'m> {
    pub(crate) fn new(modules: impl IntoIterator<Item = &'m Module>) -> Self {
        let mut map: HashMap<TypeRef, HashSet<&'m str>> = HashMap::new();
        for module in modules {
            for func in &module.functions {
                map.entry(module.type_of(func))
                    .or_default()
                    .insert(&func.name);
            }
        }
        Self { map }
    }

    /// Iterate over all of the functions in the analyzed `Module`(s) that have
    /// the specified type
    pub fn functions_with_type<'s>(&'s self, ty: &TypeRef) -> impl Iterator<Item = &'m str> + 's {
        self.map
            .get(ty)
            .into_iter()
            .map(|hs| hs.iter().copied())
            .flatten()
    }
}
