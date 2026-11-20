using AssetsTools.NET;
using AssetsTools.NET.Extra;
using Mono.Cecil;

namespace LLMChat.UnityOffline;

// Unity does not serialize multidimensional arrays. The Cecil template generator
// currently treats them as their element type, shifting all following fields.
public sealed class SerializationTemplates : IMonoBehaviourTemplateGenerator
{
    readonly string directory;
    readonly MonoCecilTempGenerator generator;
    readonly DefaultAssemblyResolver resolver = new();

    public SerializationTemplates(string directory)
    {
        this.directory = directory;
        generator = new(directory);
        resolver.AddSearchDirectory(directory);
    }

    public AssetTypeTemplateField GetTemplateField(AssetTypeTemplateField baseField, string assemblyName, string nameSpace, string className, UnityVersion version)
    {
        var name = assemblyName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) ? assemblyName : assemblyName + ".dll";
        var assembly = LoadAssembly(name);
        // Modern Unity can record the facade name in MonoScript even though
        // the player stores the UI Toolkit types in a separate module.
        if (name.Equals("UnityEngine.dll", StringComparison.OrdinalIgnoreCase) &&
            (nameSpace == "UnityEngine.UIElements" || nameSpace.StartsWith("UnityEngine.UIElements.", StringComparison.Ordinal)) &&
            assembly?.MainModule.GetType(nameSpace, className) == null)
        {
            const string uiElements = "UnityEngine.UIElementsModule.dll";
            if (LoadAssembly(uiElements)?.MainModule.GetType(nameSpace, className) != null)
                name = uiElements;
        }
        return generator.GetTemplateField(baseField, name, nameSpace, className, version);
    }

    AssemblyDefinition? LoadAssembly(string name)
    {
        if (generator.loadedAssemblies.TryGetValue(name, out var loaded)) return loaded;
        var path = Path.Combine(directory, name);
        if (!File.Exists(path)) return null;
        var assembly = AssemblyDefinition.ReadAssembly(path, new ReaderParameters { AssemblyResolver = resolver });
        generator.loadedAssemblies[name] = assembly;
        foreach (var type in assembly.MainModule.GetTypes())
            foreach (var field in type.Fields)
                if (field.FieldType is ArrayType { IsVector: false })
                    field.Attributes |= FieldAttributes.NotSerialized;
        return assembly;
    }

    public void Dispose() { generator.Dispose(); resolver.Dispose(); }
}
