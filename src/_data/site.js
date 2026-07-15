module.exports = {
  site: {
    name: "Python GIS CLI Toolcraft & Batch Processing",
    shortName: "GIS CLI Tools",
    url: "https://www.batch-processing.com",
    description:
      "Guides and runnable code for building, packaging, testing, and deploying command-line tools for spatial work in Python.",
    themeColor: "#4a3f7a",
  },
  sections: [
    {
      title: "CLI Architecture & Design Patterns",
      url: "/cli-architecture-design-patterns/",
      icon: "⚙️",
      description:
        "Typer & Click routing, subcommand organisation, Rich console output, configuration management, and environment variable sync.",
    },
    {
      title: "Spatial Batch Processing & Async Workflows",
      url: "/spatial-batch-processing-async-workflows/",
      icon: "🗺️",
      description:
        "asyncio raster pipelines, multiprocessing GDAL tasks, chunked vector reading, memory management, progress tracking, and error handling.",
    },
  ],
};

