// wxComboCtrl custom-popup test — the shape of KiCad's FILTER_COMBOPOPUP
// (common/widgets/filter_combobox.cpp: NET_SELECTOR, footprint/symbol filter
// combos): a wxComboCtrl whose popup is a wxPanel holding a filter wxTextCtrl
// and a wxListBox. The popup accepts a row from the mouse in exactly one way:
// wxEVT_LEFT_DOWN on the listbox → SetSelection(HitTest(pos)) → Accept()
// (Dismiss + combo SetValue). Native ports deliver that LEFT_DOWN for their
// list widgets and implement HitTest; the DOM port renders wxListBox as a
// <select multiple> and must do the same.
//
// Also exercises the plain wxListBox contract (no popup): LEFT_DOWN with a
// working HitTest, wxEVT_LISTBOX on selection, wxEVT_LISTBOX_DCLICK.
//
// Console lines (read by tests/e2e/combopopup.spec.ts):
//   [COMBOPOPUP] popup shown
//   [COMBOPOPUP] list LEFT_DOWN at x,y hit=N
//   [COMBOPOPUP] accepted <item>
//   [COMBOPOPUP] plain LEFT_DOWN at x,y hit=N
//   [COMBOPOPUP] plain LISTBOX sel=N
//   [COMBOPOPUP] plain DCLICK sel=N

#include "wx/wxprec.h"

#ifndef WX_PRECOMP
    #include "wx/wx.h"
#endif

#include "wx/combo.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#endif

static void ConsoleLog(const wxString& msg)
{
#ifdef __EMSCRIPTEN__
    const wxScopedCharBuffer utf8 = msg.utf8_str();
    EM_ASM({ console.log('[COMBOPOPUP] ' + UTF8ToString($0)); }, utf8.data());
#else
    wxLogMessage("%s", msg);
#endif
}

static const char* const kItems[] = {
    "<no net>", "+5V", "/A0", "/D2", "GND", "Net-(R1-Pad1)", "VCC"
};

// Mirrors FILTER_COMBOPOPUP: same widgets, same LEFT_DOWN wiring, same
// Accept() shape (selection → Dismiss → SetValue on the combo).
class ListPopup : public wxPanel, public wxComboPopup
{
public:
    bool Create(wxWindow* parent) override
    {
        wxPanel::Create(parent, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                        wxSIMPLE_BORDER);

        wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);
        sizer->Add(new wxStaticText(this, wxID_ANY, "Filter:"), 0, wxEXPAND);

        m_filter = new wxTextCtrl(this, wxID_ANY, wxEmptyString,
                                  wxDefaultPosition, wxDefaultSize,
                                  wxTE_PROCESS_ENTER);
        m_filter->SetName("popupfilter");
        sizer->Add(m_filter, 0, wxEXPAND);

        m_list = new wxListBox(this, wxID_ANY, wxDefaultPosition, wxDefaultSize,
                               0, nullptr, wxLB_SINGLE | wxLB_NEEDED_SB);
        m_list->SetName("popuplist");
        for (const char* item : kItems)
            m_list->Append(item);
        sizer->Add(m_list, 1, wxEXPAND | wxTOP, 2);

        SetSizer(sizer);
        Layout();

        Bind(wxEVT_LEFT_DOWN, &ListPopup::OnMouseClick, this);
        m_list->Bind(wxEVT_LEFT_DOWN, &ListPopup::OnMouseClick, this);
        // "<enter> in a ListBox comes in as a double-click on GTK" (KiCad)
        m_list->Bind(wxEVT_LISTBOX_DCLICK, &ListPopup::OnEnter, this);
        m_filter->Bind(wxEVT_TEXT_ENTER, &ListPopup::OnEnter, this);
        return true;
    }

    wxWindow* GetControl() override { return this; }
    wxString GetStringValue() const override { return m_value; }
    void SetStringValue(const wxString& value) override { m_value = value; }

    void OnPopup() override
    {
        m_filter->Clear();
        m_list->SetStringSelection(m_value);
        m_filter->SetFocus();
        ConsoleLog("popup shown");
    }

    wxSize GetAdjustedSize(int minWidth, int WXUNUSED(prefHeight),
                           int maxHeight) override
    {
        return wxSize(wxMax(minWidth, 260), wxMin(maxHeight, 200));
    }

    void Accept()
    {
        const int sel = m_list->GetSelection();
        const wxString value = sel >= 0 ? m_list->GetString(sel) : wxString();

        Dismiss();

        if (!value.empty())
        {
            m_value = value;
            GetComboCtrl()->SetValue(value);
        }

        ConsoleLog("accepted " + (value.empty() ? wxString("<none>") : value));
    }

private:
    void OnMouseClick(wxMouseEvent& event)
    {
        if (event.GetEventObject() == m_list)
        {
            const wxPoint pos = event.GetPosition();
            const int hit = m_list->HitTest(pos);
            ConsoleLog(wxString::Format("list LEFT_DOWN at %d,%d hit=%d",
                                        pos.x, pos.y, hit));
            m_list->SetSelection(hit);
            Accept();
            return;
        }

        // A click on the panel: accept if it lands on the list (KiCad shape).
        wxWindow* window = dynamic_cast<wxWindow*>(event.GetEventObject());
        if (window)
        {
            const wxPoint screenPos = window->ClientToScreen(event.GetPosition());
            if (m_list->GetScreenRect().Contains(screenPos))
            {
                m_list->SetSelection(m_list->HitTest(m_list->ScreenToClient(screenPos)));
                Accept();
            }
        }
    }

    void OnEnter(wxCommandEvent& WXUNUSED(event)) { Accept(); }

    wxTextCtrl* m_filter = nullptr;
    wxListBox*  m_list = nullptr;
    wxString    m_value;
};

class ComboPopupFrame : public wxFrame
{
public:
    ComboPopupFrame()
        : wxFrame(nullptr, wxID_ANY, "Combo popup test", wxPoint(0, 0),
                  wxSize(640, 460))
    {
        wxPanel* panel = new wxPanel(this);
        wxBoxSizer* sizer = new wxBoxSizer(wxVERTICAL);

        sizer->Add(new wxStaticText(panel, wxID_ANY, "Net name:"), 0, wxALL, 6);

        m_combo = new wxComboCtrl(panel, wxID_ANY, wxEmptyString,
                                  wxDefaultPosition, wxSize(320, -1),
                                  wxCB_READONLY);
        m_combo->SetName("netcombo");
        m_combo->UseAltPopupWindow(); // as FILTER_COMBOBOX does
        m_popup = new ListPopup();
        m_combo->SetPopupControl(m_popup);
        m_popup->SetStringValue(kItems[0]);
        m_combo->SetValue(kItems[0]);
        sizer->Add(m_combo, 0, wxLEFT | wxRIGHT, 6);

        sizer->Add(new wxStaticText(panel, wxID_ANY, "Plain list:"), 0, wxALL, 6);

        m_plain = new wxListBox(panel, wxID_ANY, wxDefaultPosition,
                                wxSize(320, 150), 0, nullptr, wxLB_SINGLE);
        m_plain->SetName("plainlist");
        for (const char* item : kItems)
            m_plain->Append(item);
        sizer->Add(m_plain, 0, wxLEFT | wxRIGHT | wxBOTTOM, 6);

        m_plain->Bind(wxEVT_LEFT_DOWN, [this](wxMouseEvent& event) {
            const wxPoint pos = event.GetPosition();
            ConsoleLog(wxString::Format("plain LEFT_DOWN at %d,%d hit=%d",
                                        pos.x, pos.y, m_plain->HitTest(pos)));
            event.Skip();
        });
        m_plain->Bind(wxEVT_LISTBOX, [](wxCommandEvent& event) {
            ConsoleLog(wxString::Format("plain LISTBOX sel=%d", event.GetInt()));
        });
        m_plain->Bind(wxEVT_LISTBOX_DCLICK, [](wxCommandEvent& event) {
            ConsoleLog(wxString::Format("plain DCLICK sel=%d", event.GetInt()));
        });

        // Frame-level clicks (outside the popup) are what dismiss a transient
        // popup; log them so a spec can tell "not dismissed" from "no click".
        panel->Bind(wxEVT_LEFT_DOWN, [](wxMouseEvent& event) {
            ConsoleLog(wxString::Format("frame LEFT_DOWN at %d,%d",
                                        event.GetPosition().x, event.GetPosition().y));
            event.Skip();
        });

        panel->SetSizer(sizer);
    }

private:
    wxComboCtrl* m_combo = nullptr;
    ListPopup*   m_popup = nullptr;
    wxListBox*   m_plain = nullptr;
};

class ComboPopupApp : public wxApp
{
public:
    bool OnInit() override
    {
        ComboPopupFrame* frame = new ComboPopupFrame();
        frame->Show(true);
        ConsoleLog("app ready");
        return true;
    }
};

wxIMPLEMENT_APP(ComboPopupApp);
