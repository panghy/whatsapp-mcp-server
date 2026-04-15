# 1.0.0 (2026-04-15)


### Bug Fixes

* adjust saved indicator position for MCP port input ([194140d](https://github.com/panghy/whatsapp-mcp-server/commit/194140d77160acd6903093f1e170193dc4e86a23))
* change group sync tab heading to "Group Visibility" ([91a531c](https://github.com/panghy/whatsapp-mcp-server/commit/91a531c115c4ae0eebe95d01c7c31e5b233aceaf))
* change group sync tab heading to "Group Visibility" ([dc6534f](https://github.com/panghy/whatsapp-mcp-server/commit/dc6534f06e3e7d33f4b8ef0ba3a59bad5903133e))
* change MCP port input to text type with numeric pattern for better ([f6e6236](https://github.com/panghy/whatsapp-mcp-server/commit/f6e6236ea5182686f7d94f4faf79f1bce13c9169))
* **ci:** use Node.js 22 for semantic-release compatibility ([45b2b13](https://github.com/panghy/whatsapp-mcp-server/commit/45b2b13d23dc8d3167c0884c5b461f1929b724e0))
* only show loading state on initial logs load ([1a5862b](https://github.com/panghy/whatsapp-mcp-server/commit/1a5862b8cdf8b3c2c605ec03de4ee24f7dc9ffc3))
* only update last_activity if new timestamp is more recent ([11f37bf](https://github.com/panghy/whatsapp-mcp-server/commit/11f37bff5272efb4bb6a3a078567af4a2cc24ee9))
* preserve scroll position when refreshing logs ([c181589](https://github.com/panghy/whatsapp-mcp-server/commit/c18158979fb622fe70e0223f7ace59d2ba142715))
* replace label with div in filter options to fix semantic HTML ([5b127e1](https://github.com/panghy/whatsapp-mcp-server/commit/5b127e1483135d5e21c77bac20886b969fd2ba59))
* treat log timestamps as UTC by appending 'Z' suffix to ISO string ([71206e1](https://github.com/panghy/whatsapp-mcp-server/commit/71206e14d125f6126375325435dad55cc7a4cf8a))


### Features

* add auto-update functionality with electron-updater ([6217f07](https://github.com/panghy/whatsapp-mcp-server/commit/6217f0704699debfc5a9d31fa4536080c411e38c))
* add comprehensive debug logging for message transformation pipelin ([fe4a932](https://github.com/panghy/whatsapp-mcp-server/commit/fe4a932a26d476dd3378b1849872dc81a29b406e))
* add dynamic app version display and update help/about links ([7828ec4](https://github.com/panghy/whatsapp-mcp-server/commit/7828ec488667deaba2344761ec5db75f51e7f46f))
* add filtering and search functionality to logs retrieval ([21b1a6e](https://github.com/panghy/whatsapp-mcp-server/commit/21b1a6ea9da65a7323448d18acd61a48095b1687))
* add MCP server control UI with port configuration and auto-start s ([bef185d](https://github.com/panghy/whatsapp-mcp-server/commit/bef185d3b019a3e2dd2bd0ab58697c161fd277ae))
* add MCP server implementation with WhatsApp chat tools ([dd642c5](https://github.com/panghy/whatsapp-mcp-server/commit/dd642c5fa4d9e9b3d1d8b156eae205c49ba5276b))
* add MCP server lifecycle management and database query enhancement ([ef35dd1](https://github.com/panghy/whatsapp-mcp-server/commit/ef35dd13259eb21301fe3981374d0a8c228212b3))
* add MCP status display with endpoint information and running indic ([0fa43da](https://github.com/panghy/whatsapp-mcp-server/commit/0fa43da2e3f32ab3cf5e3200940abc983935bc26))
* add total message count handler and use insert or ignore for messa ([4d3b84e](https://github.com/panghy/whatsapp-mcp-server/commit/4d3b84e9eeb07057631d094e817aaa47d5fa4c1b))
* add WhatsApp MCP bridge Electron app with full message sync ([76a158f](https://github.com/panghy/whatsapp-mcp-server/commit/76a158f03618828415fa9106a726e388848593b9))
* respect chat enabled status in MCP operations ([e949bf4](https://github.com/panghy/whatsapp-mcp-server/commit/e949bf499a3fbac9e927e911df1cc76e11227338))
* update chat last activity timestamp on message operations ([5574201](https://github.com/panghy/whatsapp-mcp-server/commit/55742010b60bd65bf27dcd41f540336714411626))
* update tray menu when main window visibility changes ([c06523d](https://github.com/panghy/whatsapp-mcp-server/commit/c06523d21640580c86d516123b3de7edd7410392))
