# ComfyUI Run Timer with History

A small timer node for ComfyUI. It shows how long your workflow took to run and keeps the times of your last five runs.

## What it does

Add the node to your workflow and it shows a clock. The clock counts up while a workflow is running and stops when the run finishes. A small dot in the corner turns green while a run is in progress.

Under the clock are five numbered buttons. Each finished run fills the next button in order: run 1 goes in button 1, run 2 in button 2, and so on. While a run is in progress, its button is green and pulses, so you can see which slot is being filled. Once all five buttons are full, the oldest time drops off the left and the newest run takes button 5.

Click any button to see that run's time on the clock. You can do this during a run, and the timer keeps counting in the background. Click the green button, or the button you picked, to go back to the live clock.

Only runs that finish successfully are saved. Runs that fail or are interrupted are left out. The history is stored in the node, so it is saved with your workflow and is still there after you reload the page.

If you wish to clear out the history, click the x next to the numbered buttons. It will ask for a confirmation and then clear all timer history.

### Using the node

1. Double-click an empty spot on the canvas and search for **ComfyUI Run Timer**. It is also in the **utils** category.
2. Run your workflow as usual.

The node has no inputs or outputs and does not affect your results. It runs in the browser only.

### Extras

- Drag the node's edge to resize it. The clock scales with the width.
- The clock color follows the node color you pick from ComfyUI's color picker. The default is ice blue.
- Right-click the node to find **Clear run history** and **Decimals**. Decimals cycles between off, 2 digits and 3 digits.
- It works with both the classic node design and Nodes 2.0.

## Installation

The node has no extra Python packages, so there is nothing to install besides the node itself.

### Option 1: Git clone

Open a terminal in your ComfyUI `custom_nodes` folder and run:

```
git clone https://github.com/RiverSide71/ComfyUI-Run-Timer.git
```

Restart ComfyUI and refresh your browser tab.

### Option 2: ComfyUI Manager

1. Open ComfyUI Manager and choose **Custom Nodes Manager**.
2. Search for **ComfyUI Run Timer** and click **Install**.
3. Restart ComfyUI and refresh your browser tab.

If you do not find it in the list, use **Install via Git URL** in the Manager and paste the repository address.
