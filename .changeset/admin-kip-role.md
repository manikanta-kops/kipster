---
"@kipster/core": minor
---

Kips know their current name and role. Every turn starts with one line from Core, such as "You are John, the admin kip of this Kipster installation", so renaming a kip takes effect on its next turn. Prompts, tool descriptions, errors and starter files say "the admin kip" for the role instead of the starting name Kip.

The admin kip works across workspaces. `list_kips` returns every kip with its workspaces. `delegate_to_kip` takes `workspaceId`, and the task runs in the recipient's own chat in that workspace with its instructions, files and memory. `copy_attachment_to_workspace` takes `workspaceId` and can copy any file of the admin kip's thread. `create_rich_doc` names its workspace with `workspaceId` instead of `organizationId`. A text submission may carry `viewingOrganizationId`, advertised by `capabilities.viewingWorkspace`, and the admin kip is told which workspace the person has open.
