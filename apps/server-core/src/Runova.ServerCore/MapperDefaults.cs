using Riok.Mapperly.Abstractions;

// Every mapper in this assembly: a target member with no source fails the build (warnings are
// errors), while source members a target leaves out, such as secrets, need no ignore list. Enums
// that differ map by name. Only partial methods and ones marked [UserMapping] are picked up on
// their own, so a helper named in Use = never quietly converts every other member of its type.
[assembly: MapperDefaults(
    RequiredMappingStrategy = RequiredMappingStrategy.Target,
    EnumMappingStrategy = EnumMappingStrategy.ByName,
    AutoUserMappings = false)]
