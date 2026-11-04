"""ComfyUI Run Timer with History of Past Five Runs: a frontend-only ComfyUI node.
"""

class ComfyUIRunTimer:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "utils"

    def noop(self):
        return ()

NODE_CLASS_MAPPINGS = {"ComfyUI-Run-Timer": ComfyUIRunTimer}
NODE_DISPLAY_NAME_MAPPINGS = {"ComfyUI-Run-Timer": "ComfyUI Run Timer"}
WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
