using Riok.Mapperly.Abstractions;

// As in Runova.Website.Core: a target property with no source fails the build (warnings are
// errors), while source properties a target leaves out, such as sealed secrets, need no ignore list.
[assembly: MapperDefaults(RequiredMappingStrategy = RequiredMappingStrategy.Target)]
