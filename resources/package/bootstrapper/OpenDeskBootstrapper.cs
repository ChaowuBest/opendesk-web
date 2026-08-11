/*
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using System.Xml.Linq;
using Microsoft.Tools.WindowsInstallerXml.Bootstrapper;
using Microsoft.Win32;

[assembly: BootstrapperApplication(typeof(OpenDesk.Installer.OpenDeskBootstrapperApplication))]

namespace OpenDesk.Installer
{
    public sealed class OpenDeskBootstrapperApplication : BootstrapperApplication
    {
        private const string PackageId = "OpenDeskMsi";
        private InstallerForm form;
        private PackageState packageState = PackageState.Unknown;
        private LaunchAction activeAction = LaunchAction.Unknown;
        private bool cancelRequested;
        private int exitCode;
        private string lastError;

        public OpenDeskBootstrapperApplication()
        {
            DetectPackageComplete += OnDetectPackageComplete;
            DetectComplete += OnDetectComplete;
            PlanComplete += OnPlanComplete;
            CacheAcquireBegin += delegate { Post(delegate { form.SetProgressStatus("ProgressCaching"); }); };
            ExecutePackageBegin += delegate { Post(delegate { form.SetProgressStatus("ProgressInstalling"); }); };
            Progress += OnProgress;
            ExecuteProgress += OnExecuteProgress;
            Error += OnError;
            ApplyComplete += OnApplyComplete;
        }

        protected override void Run()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            form = new InstallerForm(this, new Localizer(GetPayloadPath("zh-cn.wxl")));
            form.Shown += delegate
            {
                if (Command.Display == Display.None)
                {
                    form.Opacity = 0;
                    form.ShowInTaskbar = false;
                }

                Engine.Detect(form.Handle);
            };
            Application.Run(form);
            Engine.Quit(exitCode);
        }

        public string GetInstallFolder()
        {
            return Engine.FormatString(Engine.StringVariables["InstallFolder"]);
        }

        public bool GetSavedPreference(string name)
        {
            try
            {
                using (RegistryKey root = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
                using (RegistryKey key = root.OpenSubKey("SOFTWARE\\OpenDesk\\Installer"))
                {
                    object value = key == null ? null : key.GetValue(name);
                    return value == null || Convert.ToInt32(value) != 0;
                }
            }
            catch
            {
                return true;
            }
        }

        public void Install(string folder, bool desktopShortcut, bool startMenuShortcut)
        {
            Engine.StringVariables["InstallFolder"] = folder;
            Engine.NumericVariables["CreateDesktopShortcut"] = desktopShortcut ? 1 : 0;
            Engine.NumericVariables["CreateStartMenuShortcut"] = startMenuShortcut ? 1 : 0;
            StartAction(LaunchAction.Install);
        }

        public void Repair()
        {
            StartAction(LaunchAction.Repair);
        }

        public void Uninstall()
        {
            StartAction(LaunchAction.Uninstall);
        }

        public void RequestCancel()
        {
            cancelRequested = true;
            Post(delegate { form.SetProgressStatus("ProgressCanceling"); });
        }

        public void LaunchInstalledApplication()
        {
            string executable = Path.Combine(GetInstallFolder(), "opendesk.exe");
            if (File.Exists(executable))
            {
                Process.Start(executable);
            }
        }

        private void StartAction(LaunchAction action)
        {
            activeAction = action;
            cancelRequested = false;
            lastError = null;
            form.ShowProgress(action);
            Engine.Plan(action);
        }

        private void OnDetectPackageComplete(object sender, DetectPackageCompleteEventArgs e)
        {
            if (e.PackageId == PackageId)
            {
                packageState = e.State;
            }
        }

        private void OnDetectComplete(object sender, DetectCompleteEventArgs e)
        {
            if (e.Status < 0)
            {
                exitCode = e.Status;
                Post(delegate
                {
                    form.ShowFailure(e.Status, null);
                    if (Command.Display != Display.None)
                    {
                        form.Reveal();
                    }
                });
                return;
            }

            Post(delegate
            {
                form.ShowDetected(packageState == PackageState.Present, Command.Display != Display.None);
                if (Command.Display != Display.Full)
                {
                    LaunchAction action = Command.Action == LaunchAction.Unknown ? LaunchAction.Install : Command.Action;
                    StartAction(action);
                }
            });
        }

        private void OnPlanComplete(object sender, PlanCompleteEventArgs e)
        {
            if (e.Status < 0)
            {
                exitCode = e.Status;
                Post(delegate { form.ShowFailure(e.Status, lastError); });
                return;
            }

            Post(delegate
            {
                form.SetProgressStatus("ProgressInstalling");
                Engine.Apply(form.Handle);
            });
        }

        private void OnProgress(object sender, ProgressEventArgs e)
        {
            e.Result = cancelRequested ? Result.Cancel : Result.Ok;
            Post(delegate { form.UpdateProgress(e.OverallPercentage); });
        }

        private void OnExecuteProgress(object sender, ExecuteProgressEventArgs e)
        {
            e.Result = cancelRequested ? Result.Cancel : Result.Ok;
            Post(delegate { form.UpdateProgress(e.OverallPercentage); });
        }

        private void OnError(
            object sender,
            Microsoft.Tools.WindowsInstallerXml.Bootstrapper.ErrorEventArgs e
        )
        {
            lastError = e.ErrorMessage;
            e.Result = cancelRequested ? Result.Cancel : Result.Ok;
        }

        private void OnApplyComplete(object sender, ApplyCompleteEventArgs e)
        {
            exitCode = e.Status;
            Post(delegate
            {
                if (e.Status >= 0)
                {
                    form.UpdateProgress(100);
                    form.ShowSuccess(activeAction);
                }
                else
                {
                    form.ShowFailure(e.Status, lastError);
                }
            });
        }

        private void Post(MethodInvoker action)
        {
            if (form == null || form.IsDisposed)
            {
                return;
            }

            if (form.InvokeRequired)
            {
                form.BeginInvoke(action);
            }
            else
            {
                action();
            }
        }

        private static string GetPayloadPath(string fileName)
        {
            return Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), fileName);
        }
    }

    internal sealed class InstallerForm : Form
    {
        private static readonly Color Surface = Color.FromArgb(248, 250, 250);
        private static readonly Color TextColor = Color.FromArgb(23, 32, 37);
        private static readonly Color MutedColor = Color.FromArgb(102, 115, 122);
        private static readonly Color Teal = Color.FromArgb(8, 127, 114);
        private static readonly Color LightTeal = Color.FromArgb(229, 243, 240);
        private static readonly Color LineColor = Color.FromArgb(221, 230, 231);
        private static readonly Color SidebarText = Color.FromArgb(226, 224, 216);
        private static readonly Font BrandFont = new Font("Segoe UI", 19F, FontStyle.Bold, GraphicsUnit.Pixel);
        private static readonly Font HeadingFont = new Font("Microsoft YaHei UI", 27F, FontStyle.Bold, GraphicsUnit.Pixel);
        private static readonly Font BodyFont = new Font("Microsoft YaHei UI", 15F, FontStyle.Regular, GraphicsUnit.Pixel);
        private static readonly Font LabelFont = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold, GraphicsUnit.Pixel);
        private static readonly Font SmallFont = new Font("Microsoft YaHei UI", 12F, FontStyle.Regular, GraphicsUnit.Pixel);
        private static readonly Font ButtonFont = new Font("Microsoft YaHei UI", 14F, FontStyle.Bold, GraphicsUnit.Pixel);

        private readonly OpenDeskBootstrapperApplication application;
        private readonly Localizer localizer;
        private readonly Panel rightBody;
        private readonly Panel footer;
        private readonly Label[] stepLabels = new Label[3];
        private ProgressBar progressBar;
        private Label progressStatus;
        private Label progressPercent;
        private TextBox folderTextBox;
        private CheckBox desktopShortcutCheckBox;
        private CheckBox startMenuShortcutCheckBox;
        private Label installLocationLabel;
        private Button installOptionsButton;
        private Button startInstallButton;
        private string selectedFolder;
        private bool selectedDesktopShortcut;
        private bool selectedStartMenuShortcut;
        private bool busy;

        public InstallerForm(OpenDeskBootstrapperApplication application, Localizer localizer)
        {
            this.application = application;
            this.localizer = localizer;

            Name = "OpenDeskInstallerWindow";
            Text = T("Caption");
            ClientSize = new Size(920, 600);
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            MinimizeBox = true;
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None;
            Opacity = 0D;
            ShowInTaskbar = false;
            BackColor = Surface;
            BackgroundImage = LoadImage("background.png");
            BackgroundImageLayout = ImageLayout.None;
            Icon = new Icon(GetPayloadPath("opendesk.ico"));
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint,
                true
            );
            UpdateStyles();

            selectedFolder = application.GetInstallFolder();
            selectedDesktopShortcut = application.GetSavedPreference("CreateDesktopShortcut");
            selectedStartMenuShortcut = application.GetSavedPreference("CreateStartMenuShortcut");

            BuildSidebar();

            rightBody = new BufferedPanel();
            rightBody.Name = "RightContentPanel";
            rightBody.SetBounds(284, 0, 636, 516);
            rightBody.BackColor = Surface;
            Controls.Add(rightBody);

            footer = new BufferedPanel();
            footer.Name = "FooterPanel";
            footer.SetBounds(284, 516, 636, 84);
            footer.BackColor = Color.FromArgb(252, 253, 253);
            Controls.Add(footer);

            FormClosing += OnFormClosing;
            ShowWelcome(false);
        }

        public void ShowDetected(bool installed, bool reveal)
        {
            selectedFolder = application.GetInstallFolder();
            selectedDesktopShortcut = application.GetSavedPreference("CreateDesktopShortcut");
            selectedStartMenuShortcut = application.GetSavedPreference("CreateStartMenuShortcut");
            if (installed)
            {
                ShowMaintenance();
            }
            else
            {
                installLocationLabel.Text = string.Format(T("SelectedInstallLocation"), selectedFolder);
                installOptionsButton.Enabled = true;
                startInstallButton.Enabled = true;
            }

            if (reveal)
            {
                Reveal();
            }
        }

        public void Reveal()
        {
            ShowInTaskbar = true;
            Opacity = 1D;
        }

        public void ShowProgress(LaunchAction action)
        {
            busy = true;
            RenderPage(delegate
            {
                SetActiveStep(1);
                string headerId = action == LaunchAction.Repair
                    ? "ProgressRepairHeader"
                    : action == LaunchAction.Uninstall ? "ProgressUninstallHeader" : "ProgressHeader";
                string messageId = action == LaunchAction.Repair
                    ? "ProgressRepairMessage"
                    : action == LaunchAction.Uninstall ? "ProgressUninstallMessage" : "ProgressMessage";
                AddLabel(rightBody, "ProgressHeader", T(headerId), 46, 86, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "ProgressMessage", T(messageId), 46, 145, 540, 44, BodyFont, MutedColor);
                AddLabel(rightBody, "ProgressLabel", T("ProgressLabel"), 46, 244, 540, 24, LabelFont, TextColor);
                progressStatus = AddLabel(
                    rightBody,
                    "ProgressStatusLabel",
                    T("ProgressPreparing"),
                    46,
                    282,
                    500,
                    24,
                    BodyFont,
                    MutedColor
                );
                progressBar = new ProgressBar();
                progressBar.Name = "InstallProgressBar";
                progressBar.SetBounds(46, 322, 530, 18);
                progressBar.Style = ProgressBarStyle.Continuous;
                rightBody.Controls.Add(progressBar);
                progressPercent = AddLabel(
                    rightBody,
                    "ProgressPercentLabel",
                    "0%",
                    46,
                    350,
                    530,
                    22,
                    SmallFont,
                    MutedColor
                );
                progressPercent.TextAlign = ContentAlignment.MiddleRight;
                AddFooterButton("CancelInstallButton", T("ProgressCancelButton"), 470, delegate
                {
                    application.RequestCancel();
                });
            });
        }

        public void SetProgressStatus(string localizationId)
        {
            if (progressStatus != null)
            {
                progressStatus.Text = T(localizationId);
            }
        }

        public void UpdateProgress(int percentage)
        {
            if (progressBar == null)
            {
                return;
            }

            int value = Math.Max(0, Math.Min(100, percentage));
            progressBar.Value = value;
            progressPercent.Text = value.ToString() + "%";
            if (value >= 95)
            {
                SetProgressStatus("ProgressFinishing");
            }
        }

        public void ShowSuccess(LaunchAction action)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(2);
                string header = action == LaunchAction.Uninstall
                    ? T("SuccessUninstallHeader")
                    : action == LaunchAction.Repair ? T("SuccessRepairHeader") : T("SuccessInstallHeader");
                AddLabel(rightBody, "SuccessHeader", header, 46, 110, 540, 58, HeadingFont, Teal);
                AddLabel(rightBody, "SuccessMessage", T("SuccessMessage"), 46, 190, 540, 44, BodyFont, MutedColor);

                if (action != LaunchAction.Uninstall)
                {
                    AddFooterButton("LaunchOpenDeskButton", T("SuccessLaunchButton"), 336, delegate
                    {
                        application.LaunchInstalledApplication();
                        Close();
                    });
                }
                AddFooterButton("FinishButton", T("SuccessCloseButton"), 470, Close);
            });
        }

        public void ShowFailure(int status, string detail)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(-1);
                AddLabel(
                    rightBody,
                    "FailureHeader",
                    T("FailureHeader"),
                    46,
                    110,
                    540,
                    58,
                    HeadingFont,
                    Color.FromArgb(178, 59, 49)
                );
                string message = string.Format(T("FailureMessage"), "0x" + status.ToString("X8"));
                AddLabel(rightBody, "FailureMessage", message, 46, 190, 540, 60, BodyFont, MutedColor);
                if (!string.IsNullOrWhiteSpace(detail))
                {
                    AddLabel(rightBody, "FailureDetail", detail, 46, 265, 540, 100, SmallFont, MutedColor);
                }
                AddFooterButton("FailureCloseButton", T("FailureCloseButton"), 470, Close);
            });
        }

        private void ShowWelcome(bool enabled)
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(0);
                string version = application.Engine.FormatString(T("InstallEyebrow"));
                AddLabel(rightBody, "InstallEyebrow", version, 46, 58, 540, 22, SmallFont, Teal).Font = LabelFont;
                AddLabel(rightBody, "InstallHeader", T("InstallHeader"), 46, 88, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "InstallMessage", T("InstallMessage"), 46, 143, 540, 50, BodyFont, MutedColor);
                AddFeatureRow(206, "01", T("FeatureWorkspaceTitle"), T("FeatureWorkspaceText"));
                AddFeatureRow(280, "02", T("FeatureLocalTitle"), T("FeatureLocalText"));
                AddFeatureRow(354, "03", T("FeatureExtendTitle"), T("FeatureExtendText"));
                installLocationLabel = AddLabel(
                    rightBody,
                    "InstallLocationHint",
                    string.Format(T("SelectedInstallLocation"), selectedFolder),
                    46,
                    455,
                    540,
                    22,
                    SmallFont,
                    MutedColor
                );
                installLocationLabel.AutoEllipsis = true;

                AddFooterButton("ExitInstallerButton", T("InstallCloseButton"), 38, Close);
                installOptionsButton = AddFooterButton(
                    "InstallOptionsButton",
                    T("InstallOptionsButton"),
                    336,
                    ShowOptions
                );
                startInstallButton = AddFooterButton(
                    "StartInstallButton",
                    T("InstallInstallButton"),
                    470,
                    StartInstallFromWelcome
                );
                installOptionsButton.Enabled = enabled;
                startInstallButton.Enabled = enabled;
            });
        }

        private void ShowOptions()
        {
            RenderPage(delegate
            {
                SetActiveStep(0);
                AddLabel(rightBody, "OptionsEyebrow", T("OptionsEyebrow"), 46, 58, 540, 22, LabelFont, Teal);
                AddLabel(rightBody, "OptionsHeader", T("OptionsHeader"), 46, 88, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "OptionsMessage", T("OptionsMessage"), 46, 143, 540, 50, BodyFont, MutedColor);
                AddLabel(
                    rightBody,
                    "OptionsLocationLabel",
                    T("OptionsLocationLabel"),
                    46,
                    214,
                    540,
                    24,
                    LabelFont,
                    TextColor
                );

                folderTextBox = new TextBox();
                folderTextBox.Name = "InstallFolderTextBox";
                folderTextBox.Font = BodyFont;
                folderTextBox.SetBounds(46, 249, 416, 34);
                folderTextBox.Text = selectedFolder;
                rightBody.Controls.Add(folderTextBox);

                Button browse = AddButton(rightBody, "BrowseFolderButton", T("OptionsBrowseButton"), 468, 247, 128, 38);
                browse.Click += delegate
                {
                    using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                    {
                        dialog.Description = T("FolderBrowseDescription");
                        dialog.SelectedPath = folderTextBox.Text;
                        if (dialog.ShowDialog(this) == DialogResult.OK)
                        {
                            folderTextBox.Text = dialog.SelectedPath;
                        }
                    }
                };

                desktopShortcutCheckBox = AddCheckBox(
                    "CreateDesktopShortcutCheckBox",
                    T("CreateDesktopShortcut"),
                    46,
                    318,
                    selectedDesktopShortcut
                );
                startMenuShortcutCheckBox = AddCheckBox(
                    "CreateStartMenuShortcutCheckBox",
                    T("CreateStartMenuShortcut"),
                    46,
                    356,
                    selectedStartMenuShortcut
                );
                AddLabel(rightBody, "OptionsDriveHint", T("OptionsDriveHint"), 46, 407, 540, 24, SmallFont, MutedColor);
                AddLabel(
                    rightBody,
                    "ShortcutOptionsHint",
                    T("ShortcutOptionsHint"),
                    46,
                    435,
                    540,
                    24,
                    SmallFont,
                    MutedColor
                );

                AddFooterButton("OptionsBackButton", T("OptionsCancelButton"), 336, delegate { ShowWelcome(true); });
                AddFooterButton("OptionsSaveButton", T("OptionsOkButton"), 470, SaveOptions);
            });
        }

        private void ShowMaintenance()
        {
            busy = false;
            RenderPage(delegate
            {
                SetActiveStep(0);
                AddLabel(rightBody, "ModifyHeader", T("ModifyHeader"), 46, 92, 540, 46, HeadingFont, TextColor);
                AddLabel(rightBody, "ModifyMessage", T("ModifyMessage"), 46, 150, 540, 48, BodyFont, MutedColor);
                AddFeatureRow(236, "01", T("ModifyRepairButton"), T("ModifyRepairDescription"));
                AddFeatureRow(324, "02", T("ModifyUninstallButton"), T("ModifyUninstallDescription"));
                AddFooterButton("ModifyCloseButton", T("ModifyCloseButton"), 202, Close);
                AddFooterButton("RepairButton", T("ModifyRepairButton"), 336, application.Repair);
                AddFooterButton("UninstallButton", T("ModifyUninstallButton"), 470, application.Uninstall);
            });
        }

        private void StartInstallFromWelcome()
        {
            application.Install(selectedFolder, selectedDesktopShortcut, selectedStartMenuShortcut);
        }

        private void SaveOptions()
        {
            string folder = folderTextBox.Text.Trim();
            if (!IsUsableInstallPath(folder))
            {
                MessageBox.Show(
                    this,
                    T("InvalidInstallPathMessage"),
                    T("InvalidInstallPathTitle"),
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                return;
            }

            selectedFolder = folder;
            selectedDesktopShortcut = desktopShortcutCheckBox.Checked;
            selectedStartMenuShortcut = startMenuShortcutCheckBox.Checked;
            ShowWelcome(true);
        }

        private static bool IsUsableInstallPath(string folder)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder))
                {
                    return false;
                }

                string root = Path.GetPathRoot(folder);
                DriveInfo drive = new DriveInfo(root);
                return drive.IsReady;
            }
            catch
            {
                return false;
            }
        }

        private void BuildSidebar()
        {
            AddLabel(this, "BrandName", "OpenDesk", 40, 36, 180, 38, BrandFont, Color.White);
            AddLabel(this, "BrandTagline", "AI WORKSTATION", 40, 73, 180, 22, SmallFont, Color.FromArgb(153, 148, 134));
            AddLabel(this, "BrandCopy", T("BrandCopy"), 40, 138, 200, 88, BodyFont, SidebarText);
            stepLabels[0] = AddLabel(this, "StepPrepare", "01  " + T("StepPrepare"), 40, 275, 200, 28, LabelFont, SidebarText);
            stepLabels[1] = AddLabel(this, "StepInstall", "02  " + T("StepInstall"), 40, 323, 200, 28, BodyFont, Color.FromArgb(153, 148, 134));
            stepLabels[2] = AddLabel(this, "StepComplete", "03  " + T("StepComplete"), 40, 371, 200, 28, BodyFont, Color.FromArgb(153, 148, 134));
        }

        private void AddFeatureRow(int y, string number, string title, string description)
        {
            Label badge = AddLabel(rightBody, "FeatureBadge" + number, number, 46, y, 36, 36, LabelFont, Teal);
            badge.BackColor = LightTeal;
            badge.TextAlign = ContentAlignment.MiddleCenter;
            AddLabel(rightBody, "FeatureTitle" + number, title, 96, y, 440, 25, LabelFont, TextColor);
            AddLabel(rightBody, "FeatureDescription" + number, description, 96, y + 25, 440, 24, SmallFont, MutedColor);
            Panel line = new Panel();
            line.BackColor = LineColor;
            line.SetBounds(46, y + 57, 530, 1);
            rightBody.Controls.Add(line);
        }

        private CheckBox AddCheckBox(string name, string text, int x, int y, bool isChecked)
        {
            CheckBox checkBox = new CheckBox();
            checkBox.Name = name;
            checkBox.Text = text;
            checkBox.Checked = isChecked;
            checkBox.Font = BodyFont;
            checkBox.ForeColor = TextColor;
            checkBox.BackColor = Color.Transparent;
            checkBox.SetBounds(x, y, 530, 28);
            rightBody.Controls.Add(checkBox);
            return checkBox;
        }

        private Button AddFooterButton(string name, string text, int x, MethodInvoker action)
        {
            Button button = AddButton(footer, name, text, x, 20, 128, 38);
            button.Click += delegate { action(); };
            return button;
        }

        private static Button AddButton(Control parent, string name, string text, int x, int y, int width, int height)
        {
            Button button = new Button();
            button.Name = name;
            button.Text = text;
            button.Font = ButtonFont;
            button.TextAlign = ContentAlignment.MiddleCenter;
            button.FlatStyle = FlatStyle.System;
            button.SetBounds(x, y, width, height);
            parent.Controls.Add(button);
            return button;
        }

        private static Label AddLabel(
            Control parent,
            string name,
            string text,
            int x,
            int y,
            int width,
            int height,
            Font font,
            Color color
        )
        {
            Label label = new Label();
            label.Name = name;
            label.Text = text;
            label.Font = font;
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            label.TextAlign = ContentAlignment.MiddleLeft;
            label.UseCompatibleTextRendering = true;
            label.SetBounds(x, y, width, height);
            parent.Controls.Add(label);
            return label;
        }

        private void SetActiveStep(int activeStep)
        {
            for (int index = 0; index < stepLabels.Length; index += 1)
            {
                bool active = index == activeStep;
                stepLabels[index].Font = active ? LabelFont : BodyFont;
                stepLabels[index].ForeColor = active ? Color.White : Color.FromArgb(153, 148, 134);
            }
        }

        private void RenderPage(MethodInvoker buildPage)
        {
            bool redrawLocked = IsHandleCreated;
            if (redrawLocked)
            {
                NativeMethods.SetRedraw(this, false);
                NativeMethods.SetRedraw(rightBody, false);
                NativeMethods.SetRedraw(footer, false);
            }

            SuspendLayout();
            rightBody.SuspendLayout();
            footer.SuspendLayout();
            try
            {
                ClearPage();
                buildPage();
            }
            finally
            {
                footer.ResumeLayout(false);
                rightBody.ResumeLayout(false);
                ResumeLayout(false);

                if (redrawLocked)
                {
                    NativeMethods.SetRedraw(footer, true);
                    NativeMethods.SetRedraw(rightBody, true);
                    NativeMethods.SetRedraw(this, true);
                    Invalidate(true);
                    Update();
                }
            }
        }

        private void ClearPage()
        {
            DisposeChildren(rightBody);
            DisposeChildren(footer);
            progressBar = null;
            progressStatus = null;
            progressPercent = null;
            folderTextBox = null;
            desktopShortcutCheckBox = null;
            startMenuShortcutCheckBox = null;
            installLocationLabel = null;
            installOptionsButton = null;
            startInstallButton = null;
        }

        private static void DisposeChildren(Control parent)
        {
            while (parent.Controls.Count > 0)
            {
                parent.Controls[0].Dispose();
            }
        }

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!busy)
            {
                return;
            }

            e.Cancel = true;
            DialogResult result = MessageBox.Show(
                this,
                T("CancelConfirmMessage"),
                T("CancelConfirmTitle"),
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Question
            );
            if (result == DialogResult.Yes)
            {
                application.RequestCancel();
            }
        }

        private string T(string id)
        {
            return localizer.Text(id);
        }

        private static Image LoadImage(string fileName)
        {
            string directory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            using (Image source = Image.FromFile(Path.Combine(directory, fileName)))
            {
                return new Bitmap(source);
            }
        }

        private static string GetPayloadPath(string fileName)
        {
            return Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), fileName);
        }
    }

    internal sealed class BufferedPanel : Panel
    {
        public BufferedPanel()
        {
            SetStyle(
                ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint,
                true
            );
            UpdateStyles();
        }
    }

    internal static class NativeMethods
    {
        private const int WM_SETREDRAW = 0x000B;

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr window, int message, IntPtr wordParameter, IntPtr longParameter);

        public static void SetRedraw(Control control, bool enabled)
        {
            if (control.IsHandleCreated)
            {
                SendMessage(control.Handle, WM_SETREDRAW, enabled ? new IntPtr(1) : IntPtr.Zero, IntPtr.Zero);
            }
        }
    }

    internal sealed class Localizer
    {
        private readonly Dictionary<string, string> strings = new Dictionary<string, string>(StringComparer.Ordinal);

        public Localizer(string localizationPath)
        {
            XNamespace wix = "http://schemas.microsoft.com/wix/2006/localization";
            XDocument document = XDocument.Load(localizationPath);
            foreach (XElement element in document.Root.Elements(wix + "String"))
            {
                XAttribute id = element.Attribute("Id");
                if (id != null)
                {
                    strings[id.Value] = element.Value;
                }
            }
        }

        public string Text(string id)
        {
            string value;
            return strings.TryGetValue(id, out value) ? value : id;
        }
    }
}
